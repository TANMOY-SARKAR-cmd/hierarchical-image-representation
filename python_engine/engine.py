"""v0.3 graph-driven relational entity analysis orchestration."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from correspondence import match_scales, normalized_overlap_matrix, overlap_scales
from features import PIXEL_VECTOR_FIELDS, extract_features
from geometry import aggregate_sufficient_statistics, make_entity, rounded
from graph import build_relationships, containment_edge
from hierarchy import build_global_merge_tree, derive_tree_cut
from reconstruction import ERROR_HEATMAP_REFERENCE_MEAN_ABSOLUTE_RGB_DELTA, ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA, absolute_rgb_channel_sum, create_svg, mean_absolute_rgb_delta, metrics_for, reconstruct_entities, write_calibrated_error_heatmap, write_error_evidence_sidecar, write_overlay, write_relationship_overlay
from reconstruction_models import fit_entity_models, reconstruct_adaptive
from residuals import bounded_residual
from rd_optimizer import rate_distortion
from schema import SCHEMA_VERSION, config_hash, resolved_config
from segmentation import label_adjacency, segment_image, segment_image_with_diagnostics, shared_boundary_lengths
from sensitivity import run_parameter_sensitivity


def load_rgb(input_path: Path) -> np.ndarray:
    with Image.open(input_path) as source:
        rgba = np.asarray(source.convert("RGBA"), dtype=np.float32)
    return np.rint(rgba[:, :, :3] * (rgba[:, :, 3:4] / 255.0)).astype(np.uint8)


def resize_image(rgb: np.ndarray, factor: int) -> np.ndarray:
    if factor == 1:
        return rgb
    height, width = rgb.shape[:2]
    return cv2.resize(rgb, (max(2, width // factor), max(2, height // factor)), interpolation=cv2.INTER_AREA)


def build_scale(rgb: np.ndarray, factor: int, config: Dict[str, Any]) -> Tuple[np.ndarray, Dict[str, np.ndarray], np.ndarray, List[Dict[str, Any]], Dict[str, np.ndarray], Dict[str, int], Dict[str, Any]]:
    scaled_rgb = resize_image(rgb, factor)
    tensor, fields = extract_features(scaled_rgb, config)
    requested = max(8, int(config["slicSegments"] / (factor * factor)))
    labels, diagnostic = segment_image_with_diagnostics(scaled_rgb, config.get("segmentationStrategy", config["groupingMethod"]), requested, config["slicCompactness"], config["minimumRegionPixels"], config["maxInitialSegments"])
    entities: List[Dict[str, Any]] = []; masks: Dict[str, np.ndarray] = {}; label_by_id: Dict[str, int] = {}
    for label in range(1, int(labels.max()) + 1):
        entity_id = f"resolution-{factor}-micro-region-{label}"
        mask = labels == label
        entities.append(make_entity(entity_id, "micro_region", 1, factor, mask, scaled_rgb, fields, lineage={"operation": "segment", "parents": []}))
        masks[entity_id] = mask; label_by_id[entity_id] = label
    return tensor, fields, labels, entities, masks, label_by_id, diagnostic


def graph_edges_for_labels(label_by_id: Dict[str, int], labels: np.ndarray) -> Tuple[set[Tuple[str, str]], Dict[Tuple[str, str], int]]:
    id_by_label = {label: entity_id for entity_id, label in label_by_id.items()}
    adjacency = {tuple(sorted((id_by_label[first], id_by_label[second]))) for first, second in label_adjacency(labels) if first in id_by_label and second in id_by_label}
    shared = {tuple(sorted((id_by_label[first], id_by_label[second]))): count for (first, second), count in shared_boundary_lengths(labels).items() if first in id_by_label and second in id_by_label}
    return adjacency, shared


def collect_artifact_storage(output_dir: Path) -> Dict[str, Any]:
    files: Dict[str, int] = {}
    for file_path in sorted(path for path in output_dir.rglob("*") if path.is_file()):
        files[file_path.relative_to(output_dir).as_posix()] = int(file_path.stat().st_size)
    return {"schema": "ArtifactStorage@0.5", "basis": "actual_emitted_file_bytes", "files": files, "totalBytes": int(sum(files.values()))}


def canonicalize_relationships(relationships: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Emit one deterministic edge payload for equivalent derived-cut graph records.

    Region/composite/entity cuts may resolve to the same node IDs when a tree is
    shallow. Their graph evidence is then identical and belongs to several views,
    not several independent edges. Preserve that view membership instead of
    serializing duplicate edge payloads.
    """
    canonical: Dict[str, Dict[str, Any]] = {}
    for relationship in relationships:
        record = dict(relationship)
        views = sorted(set(record.pop("derivedCutViews", [])))
        key = json.dumps(record, sort_keys=True, separators=(",", ":"))
        existing = canonical.get(key)
        if existing is None:
            if views:
                record["derivedCutViews"] = views
            canonical[key] = record
            continue
        if views:
            existing["derivedCutViews"] = sorted(set(existing.get("derivedCutViews", [])) | set(views))
    return list(canonical.values())


def validate_representation(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], root_id: str) -> Dict[str, Any]:
    entity_by_id = {entity["id"]: entity for entity in entities}; non_root = [entity for entity in entities if entity["id"] != root_id]
    connected = 0; area_errors: List[float] = []; cycles = 0
    for entity in non_root:
        components = cv2.connectedComponents(masks[entity["id"]].astype(np.uint8), connectivity=4)[0] - 1
        connected += int(components == 1)
        if entity["children"]:
            child_area = sum(entity_by_id[child]["geometry"]["area"] for child in entity["children"])
            area_errors.append(abs(entity["geometry"]["area"] - child_area) / max(entity["geometry"]["area"], 1))
        seen = {entity["id"]}; current = entity
        while current.get("parentId"):
            parent_id = current["parentId"]
            if parent_id in seen:
                cycles += 1; break
            seen.add(parent_id); current = entity_by_id.get(parent_id, {})
            if not current:
                break
    leaves = [entity for entity in entities if entity["type"] == "micro_region"]
    leaf_union = np.zeros_like(next(iter(masks.values())), dtype=bool)
    for leaf in leaves: leaf_union |= masks[leaf["id"]]
    return {"connectivityScore": rounded(connected / max(len(non_root), 1), 8), "leafCoverage": rounded(float(leaf_union.mean()), 8), "parentAreaConservationError": rounded(float(np.mean(area_errors)) if area_errors else 0.0, 8), "hierarchyCycleCount": cycles, "duplicatePixelStorage": False, "valid": connected == len(non_root) and cycles == 0 and bool(leaf_union.all())}


def analyze(input_path: Path, output_dir: Path, raw_config: Dict[str, Any], progress: Optional[Callable[[str, int, str], None]] = None) -> Dict[str, Any]:
    def report(stage: str, percent: int, message: str) -> None:
        if progress is not None:
            progress(stage, percent, message)

    started = time.perf_counter(); profile: Dict[str, float] = {}; config = resolved_config(raw_config); output_dir.mkdir(parents=True, exist_ok=True)
    report("validating_input", 4, "Validating image limits and preparing the analysis workspace.")
    with Image.open(input_path) as probe:
        if probe.width * probe.height > int(config["maxImagePixels"]):
            raise ValueError(f"The image exceeds the configured {config['maxImagePixels']:,}-pixel analysis ceiling.")
    rgb = load_rgb(input_path); height, width = rgb.shape[:2]
    overlays_dir, recon_dir, error_dir = output_dir / "overlays", output_dir / "reconstructions", output_dir / "errors"
    for directory in (overlays_dir, recon_dir, error_dir): directory.mkdir(exist_ok=True)
    feature_started = time.perf_counter(); base_tensor, base_fields = extract_features(rgb, config); profile["featureExtractionMs"] = rounded((time.perf_counter() - feature_started) * 1000, 3)
    report("feature_extraction", 18, "Extracted explicit CIELAB, gradient, and local-structure features.")
    for key, output_name, colormap in (("lightness", "brightness", cv2.COLORMAP_VIRIDIS), ("edge_strength", "edge-strength", cv2.COLORMAP_INFERNO), ("gradient_x", "gradient-x", cv2.COLORMAP_COOL), ("gradient_y", "gradient-y", cv2.COLORMAP_COOL), ("complexity", "complexity", cv2.COLORMAP_TURBO)):
        write_overlay(base_fields[key], overlays_dir / f"{output_name}.png", colormap)

    segmentation_started = time.perf_counter(); scale_data: Dict[int, Tuple[np.ndarray, Dict[str, np.ndarray], np.ndarray, List[Dict[str, Any]], Dict[str, np.ndarray], Dict[str, int], Dict[str, Any]]] = {}
    segmentation_diagnostics: Dict[str, Dict[str, Any]] = {}
    requested_native = max(8, int(config["slicSegments"]))
    candidate_strategies = [config.get("segmentationStrategy", "slic")]
    if config.get("compareSegmentationBaselines", False):
        candidate_strategies = ["slic", "watershed", "felzenszwalb"]
    for strategy in dict.fromkeys(candidate_strategies):
        diagnostic_labels, diagnostic = segment_image_with_diagnostics(rgb, str(strategy), requested_native, config["slicCompactness"], config["minimumRegionPixels"], config["maxInitialSegments"])
        horizontal = diagnostic_labels[:, 1:] != diagnostic_labels[:, :-1]; vertical = diagnostic_labels[1:, :] != diagnostic_labels[:-1, :]
        edge = base_fields["edge_strength"]
        boundary_values = np.concatenate((edge[:, 1:][horizontal], edge[1:, :][vertical]))
        segmentation_diagnostics[str(strategy)] = {**diagnostic, "entityCount": int(diagnostic_labels.max()), "meanBoundaryEdgeStrength": rounded(float(boundary_values.mean()) if boundary_values.size else 0.0, 8)}
    scales: List[Dict[str, Any]] = []
    for factor in config["scaleLevels"]:
        scale_data[factor] = build_scale(rgb, factor, config)
        tensor, fields, labels, entities, masks, label_by_id, diagnostic = scale_data[factor]
        reconstruction = reconstruct_entities(entities, masks, resize_image(rgb, factor).shape)
        scales.append({"resolutionFactor": factor, "scaleFactor": factor, "resolutionName": {1: "native", 2: "half", 4: "quarter", 8: "eighth"}.get(factor, f"1/{factor}"), "width": int(labels.shape[1]), "height": int(labels.shape[0]), "featureShape": list(tensor.shape), "entityIds": [entity["id"] for entity in entities], "entityCount": len(entities), "segmentationCharacteristics": {**diagnostic, "meanComplexity": rounded(fields["complexity"].mean(), 8)}, "reconstructionError": metrics_for(resize_image(rgb, factor), reconstruction), "crossScaleLinks": []})
    profile["segmentationMs"] = rounded((time.perf_counter() - segmentation_started) * 1000, 3)
    report("segmentation", 38, "Built deterministic micro-regions across the requested image scales.")
    _, _, base_labels, micro_regions, masks, label_by_id, _ = scale_data[1]
    base_adjacency, shared_boundaries = graph_edges_for_labels(label_by_id, base_labels)

    scale_by_factor = {item["resolutionFactor"]: item for item in scales}; cross_scale: List[Dict[str, Any]] = []; cross_scale_overlaps: List[Dict[str, Any]] = []
    image_pixels = height * width
    if not config.get("runScaleConsistency", True):
        correspondence_status = "disabled"
        profile["crossScaleCorrespondenceMs"] = 0.0
    elif image_pixels > int(config["maxConsistencyPixels"]):
        correspondence_status = "skipped_pixel_limit"
        profile["crossScaleCorrespondenceMs"] = 0.0
    else:
        correspondence_status = "completed"
        correspondence_started = time.perf_counter()
        for factor in config["scaleLevels"]:
            if factor == 1:
                continue
            _, _, _, coarse_entities, coarse_masks, _, _ = scale_data[factor]
            links = match_scales(micro_regions, masks, coarse_entities, coarse_masks, factor, (height, width))
            overlap_links = overlap_scales(micro_regions, masks, coarse_entities, coarse_masks, factor, (height, width), float(config["crossScaleOverlapThreshold"]))
            scale_by_factor[1]["crossScaleLinks"].extend(links); scale_by_factor[1].setdefault("crossScaleOverlapLinks", []).extend(overlap_links)
            cross_scale.extend(links); cross_scale_overlaps.extend(overlap_links)
        profile["crossScaleCorrespondenceMs"] = rounded((time.perf_counter() - correspondence_started) * 1000, 3)
    report("cross_scale", 50, "Recorded cross-scale correspondence and overlap evidence.")

    hierarchy_started = time.perf_counter()
    merge_nodes, tree_roots, merge_evidence = build_global_merge_tree(micro_regions, masks, rgb, base_fields, config, base_adjacency)
    tree_lookup = {item["id"]: item for item in [*micro_regions, *merge_nodes]}
    fractions = config["derivedCutTargetFractions"]
    cut_targets = {name: max(len(tree_roots), int(round(len(micro_regions) * float(fraction)))) for name, fraction in fractions.items()}
    regions = derive_tree_cut(tree_roots, tree_lookup, cut_targets["region"])
    composites = derive_tree_cut(tree_roots, tree_lookup, cut_targets["composite"])
    entities_level = derive_tree_cut(tree_roots, tree_lookup, cut_targets["entity"])
    root_mask = np.ones((height, width), dtype=bool)
    root = make_entity("image-root", "image", max([item["level"] for item in [*micro_regions, *merge_nodes]] or [1]) + 1, 1, root_mask, rgb, base_fields, [entity["id"] for entity in tree_roots], {"operation": "root_anchor", "parents": [entity["id"] for entity in tree_roots], "semantics": "explicit_full_image_anchor_not_inferred_agglomeration"}, aggregate_sufficient_statistics(tree_roots))
    for entity in tree_roots: entity["parentId"] = root["id"]
    masks[root["id"]] = root_mask; all_entities = [*micro_regions, *merge_nodes, root]
    hierarchy_cuts = {name: {"targetNodeCount": cut_targets[name], "nodeIds": [entity["id"] for entity in cut], "policy": "largest_leaf_count_expansion_from_tree_roots"} for name, cut in (("region", regions), ("composite", composites), ("entity", entities_level))}
    profile["graphAgglomerationMs"] = rounded((time.perf_counter() - hierarchy_started) * 1000, 3)
    report("merge_tree", 65, "Constructed the deterministic global energy merge tree and derived cuts.")

    relationship_started = time.perf_counter(); relationships = build_relationships(micro_regions, masks, base_adjacency, (height, width), config, shared_boundaries)
    for view, level_entities in (("region", regions), ("composite", composites), ("entity", entities_level)):
        for relationship in build_relationships(level_entities, masks, set(), (height, width), config):
            relationship["derivedCutViews"] = [view]
            relationships.append(relationship)
    for entity in all_entities:
        for child_id in entity["children"]:
            relationships.append(containment_edge(entity, next(child for child in all_entities if child["id"] == child_id)))
    relationships.extend(cross_scale); relationships.extend(cross_scale_overlaps); relationships = canonicalize_relationships(relationships); profile["relationshipConstructionMs"] = rounded((time.perf_counter() - relationship_started) * 1000, 3)
    write_relationship_overlay(rgb, micro_regions, [edge for edge in relationships if edge.get("entityLevel") == 1], overlays_dir / "relationship-graph.png")
    write_relationship_overlay(rgb, micro_regions, [edge for edge in relationships if edge.get("entityLevel") == 1], overlays_dir / "normalized-distance-graph.png", True)
    report("relationship_graph", 74, "Built sparse relationship graphs and hierarchy evidence.")

    reconstruction_started = time.perf_counter(); reconstruction_groups = {"level1": micro_regions, "level2": regions, "level3": composites, "level4": entities_level}; reconstruction_metadata: Dict[str, Any] = {}; reconstruction_images: Dict[str, np.ndarray] = {}
    for name, entities in reconstruction_groups.items():
        reconstruction = reconstruct_entities(entities, masks, rgb.shape); Image.fromarray(reconstruction, mode="RGB").save(recon_dir / f"{name}.png")
        reconstruction_metadata[name] = {"artifact": f"reconstructions/{name}.png", "entityCount": len(entities), "model": "constant", **metrics_for(rgb, reconstruction)}
        reconstruction_images[name] = reconstruction
    constant_reconstruction = reconstruction_images["level1"]
    fit_entity_models(micro_regions, masks, rgb, base_fields, config)
    parametric_reconstruction = reconstruct_adaptive(micro_regions, masks, rgb.shape)
    residual_reconstruction, quantized_residual, encoded_residual, residual_metadata = bounded_residual(rgb, parametric_reconstruction, config)
    Image.fromarray(constant_reconstruction, mode="RGB").save(recon_dir / "constant.png")
    Image.fromarray(parametric_reconstruction, mode="RGB").save(recon_dir / "parametric.png")
    Image.fromarray(residual_reconstruction, mode="RGB").save(recon_dir / "residual.png")
    Image.fromarray(residual_reconstruction, mode="RGB").save(recon_dir / "full.png")
    if encoded_residual is not None:
        (output_dir / "residuals.npz").write_bytes(encoded_residual)
        residual_metadata["artifact"] = "residuals.npz"
    reconstruction_metadata["constant"] = {"artifact": "reconstructions/constant.png", "entityCount": len(micro_regions), "model": "constant", **metrics_for(rgb, constant_reconstruction)}
    reconstruction_metadata["parametric"] = {"artifact": "reconstructions/parametric.png", "entityCount": len(micro_regions), "model": "adaptive_lab", **metrics_for(rgb, parametric_reconstruction)}
    reconstruction_metadata["residual"] = {"artifact": "reconstructions/residual.png", "entityCount": len(micro_regions), "model": "adaptive_lab_plus_quantized_residual", "residual": residual_metadata, **metrics_for(rgb, residual_reconstruction)}
    reconstruction_metadata["full"] = {"artifact": "reconstructions/full.png", "entityCount": len(micro_regions), "model": "adaptive_lab_plus_quantized_residual", "residual": residual_metadata, **metrics_for(rgb, residual_reconstruction)}
    reconstruction_images.update({"constant": constant_reconstruction, "parametric": parametric_reconstruction, "residual": residual_reconstruction, "full": residual_reconstruction})
    full_reconstruction = residual_reconstruction
    Image.fromarray(full_reconstruction, mode="RGB").save(output_dir / "reconstructed.png")
    absolute_error = np.abs(rgb.astype(np.float32) - full_reconstruction.astype(np.float32)).mean(axis=2); per_region_error = np.zeros((height, width), dtype=np.float32)
    for entity in micro_regions: per_region_error[masks[entity["id"]]] = float(absolute_error[masks[entity["id"]]].mean())
    parametric_error = np.abs(rgb.astype(np.float32) - parametric_reconstruction.astype(np.float32)).mean(axis=2)
    residual_energy = np.abs(quantized_residual.astype(np.float32)).mean(axis=2)
    mode_error_dir = error_dir / "by-reconstruction"; mode_error_dir.mkdir(exist_ok=True)
    mode_evidence_dir = error_dir / "evidence"; mode_evidence_dir.mkdir(exist_ok=True)
    mode_error_artifacts: Dict[str, str] = {}; mode_error_metadata: Dict[str, Dict[str, float]] = {}; mode_error_evidence: Dict[str, Dict[str, Any]] = {}
    for name, reconstruction in reconstruction_images.items():
        relative_path = f"errors/by-reconstruction/{name}.png"
        mode_error_metadata[name] = write_calibrated_error_heatmap(rgb, reconstruction, output_dir / relative_path)
        mode_error_artifacts[name] = relative_path
        evidence_path = f"errors/evidence/{name}.delta-rgb.gz"
        mode_error_evidence[name] = {"artifact": evidence_path, "schema": "AbsoluteRgbChannelSum@0.7", "semantics": "exact_mean_absolute_delta_rgb_equals_channel_sum_divided_by_three", **write_error_evidence_sidecar(absolute_rgb_channel_sum(rgb, reconstruction), output_dir / evidence_path)}
    write_overlay(absolute_error, error_dir / "absolute-error.png", cv2.COLORMAP_INFERNO); write_overlay(parametric_error, error_dir / "parametric-error.png", cv2.COLORMAP_INFERNO); write_overlay(per_region_error, error_dir / "per-region-error.png", cv2.COLORMAP_MAGMA); write_overlay(residual_energy, error_dir / "residual-energy.png", cv2.COLORMAP_TURBO); create_svg(base_labels, rgb, output_dir / "reconstruction.svg")
    profile["reconstructionMs"] = rounded((time.perf_counter() - reconstruction_started) * 1000, 3)
    report("reconstruction", 88, "Rendered structural, adaptive, and residual reconstruction artifacts.")
    sensitivity_report = run_parameter_sensitivity(input_path, output_dir, config, analyze) if config.get("runParameterSensitivity", False) else None

    validity = validate_representation(all_entities, masks, root["id"])
    overlap_matrix = normalized_overlap_matrix(cross_scale_overlaps)
    correspondence_summary = {
        "status": correspondence_status,
        "correspondenceMethod": "Hungarian IoU/centroid/appearance/area cost",
        "matchedEntityCount": len(cross_scale), "overlapLinkCount": len(cross_scale_overlaps),
        "centroidStability": rounded(float(np.mean([item["centroidDistance"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "sizeRatioStability": rounded(float(np.mean([item["logAreaDifference"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "brightnessStability": 0.0,
        "colorStability": rounded(float(np.mean([item["appearanceDifference"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "relationshipStability": rounded(float(np.mean([item["confidence"] for item in cross_scale])) if cross_scale else 0.0, 8),
    }
    np.savez_compressed(output_dir / "features.npz", pixelVectors=base_tensor, pixelVectorFields=np.array(PIXEL_VECTOR_FIELDS), pixelToMicroregion=base_labels, **base_fields)
    source_bytes = input_path.stat().st_size
    constant_metrics, parametric_metrics, residual_metrics = metrics_for(rgb, constant_reconstruction), metrics_for(rgb, parametric_reconstruction), metrics_for(rgb, full_reconstruction)
    model_bytes = int(sum(entity.get("appearanceModel", {}).get("parameterCount", 0) for entity in micro_regions) * 4)
    heuristic_rd_summary = {"basis": "parameter_payload_estimate_not_serialized_storage", "modes": {"constant": rate_distortion(constant_metrics["mse"], len(micro_regions) * 12, height * width, config), "parametric": rate_distortion(parametric_metrics["mse"], model_bytes, height * width, config), "residual": residual_metadata["heuristicRateDistortion"]}}
    quality = {**residual_metrics, "sourceBytes": source_bytes, "rawRgbBytes": int(rgb.nbytes), "representationBytes": 0, "reconstructedBytes": 0, "representationOverhead": 0.0, "processingTimeMs": 0.0}
    experiment = {"id": f"exp-{config_hash(config)}-{int(started * 1000)}", "engineVersion": SCHEMA_VERSION, "configHash": config_hash(config), "algorithm": "global_energy_scored_merge_tree+derived_cuts+adaptive_reconstruction", "timestampEpochMs": int(time.time() * 1000), "researchPrototype": True}
    representation: Dict[str, Any] = {
        "representation_version": SCHEMA_VERSION, "version": SCHEMA_VERSION, "coordinateSystem": "pixel coordinates are [x, y]; boundingBox is [minX, minY, maxX, maxY], inclusive", "experiment": experiment, "configuration": config,
        "image": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes}, "image_metadata": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes},
        "feature_schema": {"PixelVector": {"fields": PIXEL_VECTOR_FIELDS, "shape": list(base_tensor.shape), "categories": ["geometry", "appearance", "local_structure"], "units": {"lab_l": "CIELAB_Lstar_0_to_100", "lab_a": "CIELAB_astar", "lab_b": "CIELAB_bstar", "gradient_magnitude": "robust_normalized_unit_interval", "edge_strength": "continuous_normalized_gradient_magnitude"}, "storage": "features.npz:pixelVectors"}, "EntityVector": {"schema": "EntityVector@0.7", "storage": "entities[].vector", "categories": ["geometry", "appearance", "structure", "shape"]}, "AppearanceModel": {"schema": "AppearanceModel@0.7", "storage": "entities[].appearanceModel", "coordinateSystem": "entity_local_bounding_box_normalized_minus1_to1", "candidates": config["appearanceModelCandidates"]}},
        "features": {"shape": list(base_tensor.shape), "channels": PIXEL_VECTOR_FIELDS, "artifact": "features.npz"}, "pixelLevel": {"assignmentArtifact": "features.npz", "assignmentKey": "pixelToMicroregion", "labelToMicroregionId": {str(label): f"resolution-1-micro-region-{label}" for label in range(1, int(base_labels.max()) + 1)}},
        "resolutionPyramid": scales, "scales": scales, "scaleLevels": scales, "hierarchy": {"levels": {"pixel": 0, "micro_region": 1, "derived_region": 2, "derived_composite": 3, "derived_entity": 4, "image": root["level"]}, "rootId": root["id"], "grouping": "global_energy_scored_4_neighbour_merge_tree_with_derived_cuts", "rootSemantics": "explicit_full_image_anchor_not_inferred_agglomeration", "treeNodeIds": [item["id"] for item in merge_nodes], "treeRootIds": [item["id"] for item in tree_roots], "cuts": hierarchy_cuts, "mergeEvidence": merge_evidence}, "entities": all_entities, "relationships": relationships,
        "graph_metadata": {"construction": "4-neighbour region adjacency plus spatial/appearance KNN candidates; global energy tree recomputes active merge candidates after every accepted union", "relationshipDensity": rounded(len(relationships) / max(len(all_entities), 1), 8), "candidateSources": ["adjacent", "spatial_knn", "appearance_knn", "hierarchy", "cross_scale_overlap"]}, "segmentationDiagnostics": segmentation_diagnostics,
        "normalization_methods": {"normalizedDistance": "distance / image diagonal", "logAreaRatio": "log((source area + epsilon) / (target area + epsilon))", "logBrightnessRatio": "log((source brightness + epsilon) / (target brightness + epsilon))", "colorDistance": "DeltaE76 over explicit CIELAB units"},
        "reconstruction_metadata": {"outputs": reconstruction_metadata, "heuristicRateDistortion": heuristic_rd_summary, "residual": residual_metadata, "errorHeatmaps": {"schema": "CalibratedAbsoluteRgbErrorHeatmap@0.7", "semantics": "mean_absolute_rgb_difference_for_matching_reconstruction_artifact", "referenceMeanAbsoluteRgbDelta": ERROR_HEATMAP_REFERENCE_MEAN_ABSOLUTE_RGB_DELTA, "transparentBelowMeanAbsoluteRgbDelta": ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA, "byReconstruction": mode_error_metadata, "evidenceByReconstruction": mode_error_evidence}, "errorArtifacts": {"absolutePixelError": "errors/absolute-error.png", "parametricError": "errors/parametric-error.png", "perRegionError": "errors/per-region-error.png", "residualEnergy": "errors/residual-energy.png", "byReconstruction": mode_error_artifacts, "evidenceByReconstruction": mode_error_evidence}}, "scale_correspondence": {"method": "Hungarian one-to-one best match on IoU, normalized centroid, appearance, and log-area terms", "bestMatches": cross_scale, "overlapLinks": cross_scale_overlaps, "normalizedOverlapMatrix": overlap_matrix, "links": cross_scale}, "scale_consistency": correspondence_summary, "parameterSensitivity": sensitivity_report, "validity": validity, "profiling": profile, "researchPrototype": {"status": "deterministic_internal_evaluation", "notScientificValidation": True, "notCodecRateMeasurement": True}, "artifactStorage": {"schema": "ArtifactStorage@0.7", "basis": "actual_emitted_file_bytes", "files": {}, "totalBytes": 0},
        "artifacts": {"features": "features.npz", "residuals": residual_metadata.get("artifact"), "parameterSensitivity": "sensitivity/report.json" if sensitivity_report else None, "reconstructedPng": "reconstructed.png", "svg": "reconstruction.svg", "reconstructions": {name: value["artifact"] for name, value in reconstruction_metadata.items()}, "errors": {"absolutePixelError": "errors/absolute-error.png", "parametricError": "errors/parametric-error.png", "perRegionError": "errors/per-region-error.png", "residualEnergy": "errors/residual-energy.png", "byReconstruction": mode_error_artifacts, "evidenceByReconstruction": mode_error_evidence}, "overlays": {"brightness": "overlays/brightness.png", "edgeStrength": "overlays/edge-strength.png", "gradientX": "overlays/gradient-x.png", "gradientY": "overlays/gradient-y.png", "complexity": "overlays/complexity.png", "relationshipGraph": "overlays/relationship-graph.png", "normalizedDistanceGraph": "overlays/normalized-distance-graph.png", "residualEnergy": "errors/residual-energy.png"}}, "metrics": quality, "quality_metrics": quality,
    }
    report("serialization", 94, "Serializing representation evidence and measured artifact metadata.")
    serialization_started = time.perf_counter(); representation_path = output_dir / "representation.json"; quality["processingTimeMs"] = rounded((time.perf_counter() - started) * 1000, 3)
    for _ in range(5):
        representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
        measured_storage = collect_artifact_storage(output_dir)
        for output in reconstruction_metadata.values():
            output["artifactBytes"] = measured_storage["files"].get(output["artifact"], 0)
        residual_metadata["actualEncodedBytes"] = measured_storage["files"].get("residuals.npz", 0)
        residual_metadata["budgetMet"] = residual_metadata["actualEncodedBytes"] <= int(config["residualBudgetBytes"])
        quality["representationBytes"] = measured_storage["files"].get("representation.json", 0) + measured_storage["files"].get("features.npz", 0)
        quality["reconstructedBytes"] = measured_storage["files"].get("reconstructed.png", 0)
        quality["representationOverhead"] = rounded(quality["representationBytes"] / max(quality["rawRgbBytes"], 1), 8)
        if representation["artifactStorage"] == measured_storage:
            break
        representation["artifactStorage"] = measured_storage
    profile["serializationMs"] = rounded((time.perf_counter() - serialization_started) * 1000, 3)
    report("analysis_complete", 96, "Analysis computation completed; artifacts are ready for secure upload.")
    return {"representationPath": str(representation_path), "entityCount": len(all_entities), "relationshipCount": len(relationships)}

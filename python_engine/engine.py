"""v0.3 graph-driven relational entity analysis orchestration."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from PIL import Image

from correspondence import match_scales
from features import PIXEL_VECTOR_FIELDS, extract_features
from geometry import make_entity, rounded
from graph import build_relationships, containment_edge
from hierarchy import graph_group_level
from reconstruction import create_svg, metrics_for, reconstruct_entities, write_overlay, write_relationship_overlay
from schema import SCHEMA_VERSION, config_hash, resolved_config
from segmentation import label_adjacency, segment_slic, shared_boundary_lengths


def load_rgb(input_path: Path) -> np.ndarray:
    with Image.open(input_path) as source:
        rgba = np.asarray(source.convert("RGBA"), dtype=np.float32)
    return np.rint(rgba[:, :, :3] * (rgba[:, :, 3:4] / 255.0)).astype(np.uint8)


def resize_image(rgb: np.ndarray, factor: int) -> np.ndarray:
    if factor == 1:
        return rgb
    height, width = rgb.shape[:2]
    return cv2.resize(rgb, (max(2, width // factor), max(2, height // factor)), interpolation=cv2.INTER_AREA)


def build_scale(rgb: np.ndarray, factor: int, config: Dict[str, Any]) -> Tuple[np.ndarray, Dict[str, np.ndarray], np.ndarray, List[Dict[str, Any]], Dict[str, np.ndarray], Dict[str, int]]:
    scaled_rgb = resize_image(rgb, factor)
    tensor, fields = extract_features(scaled_rgb, config)
    requested = max(8, int(config["slicSegments"] / (factor * factor)))
    labels = segment_slic(scaled_rgb, requested, config["slicCompactness"], config["minimumRegionPixels"])
    entities: List[Dict[str, Any]] = []; masks: Dict[str, np.ndarray] = {}; label_by_id: Dict[str, int] = {}
    for label in range(1, int(labels.max()) + 1):
        entity_id = f"resolution-{factor}-micro-region-{label}"
        mask = labels == label
        entities.append(make_entity(entity_id, "micro_region", 1, factor, mask, scaled_rgb, fields, lineage={"operation": "segment", "parents": []}))
        masks[entity_id] = mask; label_by_id[entity_id] = label
    return tensor, fields, labels, entities, masks, label_by_id


def graph_edges_for_labels(label_by_id: Dict[str, int], labels: np.ndarray) -> Tuple[set[Tuple[str, str]], Dict[Tuple[str, str], int]]:
    id_by_label = {label: entity_id for entity_id, label in label_by_id.items()}
    adjacency = {tuple(sorted((id_by_label[first], id_by_label[second]))) for first, second in label_adjacency(labels) if first in id_by_label and second in id_by_label}
    shared = {tuple(sorted((id_by_label[first], id_by_label[second]))): count for (first, second), count in shared_boundary_lengths(labels).items() if first in id_by_label and second in id_by_label}
    return adjacency, shared


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


def analyze(input_path: Path, output_dir: Path, raw_config: Dict[str, Any]) -> Dict[str, Any]:
    started = time.perf_counter(); profile: Dict[str, float] = {}; config = resolved_config(raw_config); output_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(input_path) as probe:
        if probe.width * probe.height > int(config["maxImagePixels"]):
            raise ValueError(f"The image exceeds the configured {config['maxImagePixels']:,}-pixel analysis ceiling.")
    rgb = load_rgb(input_path); height, width = rgb.shape[:2]
    overlays_dir, recon_dir, error_dir = output_dir / "overlays", output_dir / "reconstructions", output_dir / "errors"
    for directory in (overlays_dir, recon_dir, error_dir): directory.mkdir(exist_ok=True)
    feature_started = time.perf_counter(); base_tensor, base_fields = extract_features(rgb, config); profile["featureExtractionMs"] = rounded((time.perf_counter() - feature_started) * 1000, 3)
    for key, output_name, colormap in (("lightness", "brightness", cv2.COLORMAP_VIRIDIS), ("edge_strength", "edge-strength", cv2.COLORMAP_INFERNO), ("gradient_x", "gradient-x", cv2.COLORMAP_COOL), ("gradient_y", "gradient-y", cv2.COLORMAP_COOL), ("complexity", "complexity", cv2.COLORMAP_TURBO)):
        write_overlay(base_fields[key], overlays_dir / f"{output_name}.png", colormap)

    segmentation_started = time.perf_counter(); scale_data: Dict[int, Tuple[np.ndarray, Dict[str, np.ndarray], np.ndarray, List[Dict[str, Any]], Dict[str, np.ndarray], Dict[str, int]]] = {}
    scales: List[Dict[str, Any]] = []
    for factor in config["scaleLevels"]:
        scale_data[factor] = build_scale(rgb, factor, config)
        tensor, fields, labels, entities, masks, label_by_id = scale_data[factor]
        reconstruction = reconstruct_entities(entities, masks, resize_image(rgb, factor).shape)
        scales.append({"resolutionFactor": factor, "scaleFactor": factor, "resolutionName": {1: "native", 2: "half", 4: "quarter", 8: "eighth"}.get(factor, f"1/{factor}"), "width": int(labels.shape[1]), "height": int(labels.shape[0]), "featureShape": list(tensor.shape), "entityIds": [entity["id"] for entity in entities], "entityCount": len(entities), "segmentationCharacteristics": {"requestedSegments": max(8, int(config["slicSegments"] / (factor * factor))), "actualSegments": int(labels.max()), "meanComplexity": rounded(fields["complexity"].mean(), 8)}, "reconstructionError": metrics_for(resize_image(rgb, factor), reconstruction), "crossScaleLinks": []})
    profile["segmentationMs"] = rounded((time.perf_counter() - segmentation_started) * 1000, 3)
    _, _, base_labels, micro_regions, masks, label_by_id = scale_data[1]
    base_adjacency, shared_boundaries = graph_edges_for_labels(label_by_id, base_labels)

    correspondence_started = time.perf_counter(); scale_by_factor = {item["resolutionFactor"]: item for item in scales}; cross_scale: List[Dict[str, Any]] = []
    for factor in config["scaleLevels"]:
        if factor == 1:
            continue
        _, _, _, coarse_entities, coarse_masks, _ = scale_data[factor]
        links = match_scales(micro_regions, masks, coarse_entities, coarse_masks, factor, (height, width))
        scale_by_factor[1]["crossScaleLinks"].extend(links); cross_scale.extend(links)
    profile["crossScaleCorrespondenceMs"] = rounded((time.perf_counter() - correspondence_started) * 1000, 3)

    hierarchy_started = time.perf_counter()
    regions = graph_group_level(micro_regions, masks, rgb, base_fields, "region", 2, config, 1.0)
    composites = graph_group_level(regions, masks, rgb, base_fields, "composite", 3, config, 0.92)
    entities_level = graph_group_level(composites, masks, rgb, base_fields, "entity", 4, config, 0.84)
    root_mask = np.ones((height, width), dtype=bool)
    root = make_entity("image-root", "image", 5, 1, root_mask, rgb, base_fields, [entity["id"] for entity in entities_level], {"operation": "root", "parents": [entity["id"] for entity in entities_level]})
    for entity in entities_level: entity["parentId"] = root["id"]
    masks[root["id"]] = root_mask; all_entities = micro_regions + regions + composites + entities_level + [root]
    profile["graphAgglomerationMs"] = rounded((time.perf_counter() - hierarchy_started) * 1000, 3)

    relationship_started = time.perf_counter(); relationships = build_relationships(micro_regions, masks, base_adjacency, (height, width), config, shared_boundaries)
    for level_entities in (regions, composites, entities_level):
        relationships.extend(build_relationships(level_entities, masks, set(), (height, width), config))
    for entity in all_entities:
        for child_id in entity["children"]:
            relationships.append(containment_edge(entity, next(child for child in all_entities if child["id"] == child_id)))
    relationships.extend(cross_scale); profile["relationshipConstructionMs"] = rounded((time.perf_counter() - relationship_started) * 1000, 3)
    write_relationship_overlay(rgb, micro_regions, [edge for edge in relationships if edge.get("entityLevel") == 1], overlays_dir / "relationship-graph.png")
    write_relationship_overlay(rgb, micro_regions, [edge for edge in relationships if edge.get("entityLevel") == 1], overlays_dir / "normalized-distance-graph.png", True)

    reconstruction_started = time.perf_counter(); reconstruction_groups = {"level1": micro_regions, "level2": regions, "level3": composites, "level4": entities_level, "full": micro_regions}; reconstruction_metadata: Dict[str, Any] = {}
    full_reconstruction = None
    for name, entities in reconstruction_groups.items():
        reconstruction = reconstruct_entities(entities, masks, rgb.shape); Image.fromarray(reconstruction, mode="RGB").save(recon_dir / f"{name}.png")
        reconstruction_metadata[name] = {"artifact": f"reconstructions/{name}.png", "entityCount": len(entities), "model": "constant", **metrics_for(rgb, reconstruction)}
        if name == "full": full_reconstruction = reconstruction
    assert full_reconstruction is not None
    Image.fromarray(full_reconstruction, mode="RGB").save(output_dir / "reconstructed.png")
    absolute_error = np.abs(rgb.astype(np.float32) - full_reconstruction.astype(np.float32)).mean(axis=2); per_region_error = np.zeros((height, width), dtype=np.float32)
    for entity in micro_regions: per_region_error[masks[entity["id"]]] = float(absolute_error[masks[entity["id"]]].mean())
    write_overlay(absolute_error, error_dir / "absolute-error.png", cv2.COLORMAP_INFERNO); write_overlay(per_region_error, error_dir / "per-region-error.png", cv2.COLORMAP_MAGMA); create_svg(base_labels, rgb, output_dir / "reconstruction.svg")
    profile["reconstructionMs"] = rounded((time.perf_counter() - reconstruction_started) * 1000, 3)

    validity = validate_representation(all_entities, masks, root["id"])
    correspondence_summary = {
        "status": "completed" if config.get("runScaleConsistency", True) else "disabled",
        "correspondenceMethod": "Hungarian IoU/centroid/appearance/area cost",
        "matchedEntityCount": len(cross_scale),
        "centroidStability": rounded(float(np.mean([item["centroidDistance"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "sizeRatioStability": rounded(float(np.mean([item["logAreaDifference"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "brightnessStability": 0.0,
        "colorStability": rounded(float(np.mean([item["appearanceDifference"] for item in cross_scale])) if cross_scale else 0.0, 8),
        "relationshipStability": rounded(float(np.mean([item["confidence"] for item in cross_scale])) if cross_scale else 0.0, 8),
    }
    np.savez_compressed(output_dir / "features.npz", pixelVectors=base_tensor, pixelVectorFields=np.array(PIXEL_VECTOR_FIELDS), pixelToMicroregion=base_labels, **base_fields)
    source_bytes = input_path.stat().st_size
    quality = {**metrics_for(rgb, full_reconstruction), "sourceBytes": source_bytes, "rawRgbBytes": int(rgb.nbytes), "representationBytes": 0, "reconstructedBytes": 0, "representationOverhead": 0.0, "processingTimeMs": 0.0}
    experiment = {"id": f"exp-{config_hash(config)}-{int(started * 1000)}", "engineVersion": SCHEMA_VERSION, "configHash": config_hash(config), "algorithm": "graph_agglomerative", "timestampEpochMs": int(time.time() * 1000)}
    representation: Dict[str, Any] = {
        "representation_version": SCHEMA_VERSION, "version": SCHEMA_VERSION, "coordinateSystem": "pixel coordinates are [x, y]; boundingBox is [minX, minY, maxX, maxY], inclusive", "experiment": experiment, "configuration": config,
        "image": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes}, "image_metadata": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes},
        "feature_schema": {"PixelVector": {"fields": PIXEL_VECTOR_FIELDS, "shape": list(base_tensor.shape), "categories": ["geometry", "appearance", "local_structure"], "normalization": "coordinates use fixed image bounds; local positive fields use median/MAD robust scaling clipped to [-1,1]", "storage": "features.npz:pixelVectors"}, "EntityVector": {"schema": "EntityVector@0.3", "storage": "entities[].vector", "categories": ["geometry", "appearance", "structure", "shape"]}},
        "features": {"shape": list(base_tensor.shape), "channels": PIXEL_VECTOR_FIELDS, "artifact": "features.npz"}, "pixelLevel": {"assignmentArtifact": "features.npz", "assignmentKey": "pixelToMicroregion", "labelToMicroregionId": {str(label): f"resolution-1-micro-region-{label}" for label in range(1, int(base_labels.max()) + 1)}},
        "resolutionPyramid": scales, "scales": scales, "scaleLevels": scales, "hierarchy": {"levels": {"pixel": 0, "micro_region": 1, "region": 2, "composite": 3, "entity": 4, "image": 5}, "rootId": root["id"], "grouping": "connectivity-constrained graph agglomeration"}, "entities": all_entities, "relationships": relationships,
        "graph_metadata": {"construction": "region adjacency plus spatial/appearance KNN candidates; graph agglomeration uses merge affinity", "relationshipDensity": rounded(len(relationships) / max(len(all_entities), 1), 8), "candidateSources": ["adjacent", "spatial_knn", "appearance_knn", "hierarchy"]},
        "normalization_methods": {"normalizedDistance": "distance / image diagonal", "logAreaRatio": "log((source area + epsilon) / (target area + epsilon))", "logBrightnessRatio": "log((source brightness + epsilon) / (target brightness + epsilon))", "colorDistance": "Euclidean CIE Lab distance over normalized Lab components"},
        "reconstruction_metadata": {"outputs": reconstruction_metadata, "errorArtifacts": {"absolutePixelError": "errors/absolute-error.png", "perRegionError": "errors/per-region-error.png"}}, "scale_correspondence": {"method": "Hungarian minimum cost on IoU, normalized centroid, appearance, and log-area terms", "links": cross_scale}, "scale_consistency": correspondence_summary, "validity": validity, "profiling": profile,
        "artifacts": {"features": "features.npz", "reconstructedPng": "reconstructed.png", "svg": "reconstruction.svg", "reconstructions": {name: value["artifact"] for name, value in reconstruction_metadata.items()}, "errors": {"absolutePixelError": "errors/absolute-error.png", "perRegionError": "errors/per-region-error.png"}, "overlays": {"brightness": "overlays/brightness.png", "edgeStrength": "overlays/edge-strength.png", "gradientX": "overlays/gradient-x.png", "gradientY": "overlays/gradient-y.png", "complexity": "overlays/complexity.png", "relationshipGraph": "overlays/relationship-graph.png", "normalizedDistanceGraph": "overlays/normalized-distance-graph.png"}}, "metrics": quality, "quality_metrics": quality,
    }
    serialization_started = time.perf_counter(); representation_path = output_dir / "representation.json"; representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    quality["representationBytes"] = representation_path.stat().st_size + (output_dir / "features.npz").stat().st_size; quality["reconstructedBytes"] = (output_dir / "reconstructed.png").stat().st_size; quality["representationOverhead"] = rounded(quality["representationBytes"] / max(quality["rawRgbBytes"], 1), 8); quality["processingTimeMs"] = rounded((time.perf_counter() - started) * 1000, 3); profile["serializationMs"] = rounded((time.perf_counter() - serialization_started) * 1000, 3)
    representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    return {"representationPath": str(representation_path), "entityCount": len(all_entities), "relationshipCount": len(relationships)}

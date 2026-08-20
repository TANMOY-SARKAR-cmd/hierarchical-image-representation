#!/usr/bin/env python3
"""Deterministic hierarchical image representation analysis engine.

The Node application invokes this script as a bounded child process. All output
artifacts are written to the caller-provided directory; stdout emits only a
small JSON completion envelope so the TypeScript bridge can parse it safely.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation
from skimage.measure import find_contours, perimeter as mask_perimeter
from skimage.metrics import peak_signal_noise_ratio, structural_similarity
from skimage.segmentation import relabel_sequential, slic


FEATURE_CHANNELS = [
    "x",
    "y",
    "red",
    "green",
    "blue",
    "brightness",
    "gradient_x",
    "gradient_y",
    "edge_strength",
]


def normalize_unit(values: np.ndarray) -> np.ndarray:
    minimum = float(values.min())
    maximum = float(values.max())
    if maximum - minimum <= 1e-12:
        return np.zeros_like(values, dtype=np.float32)
    return ((values - minimum) / (maximum - minimum)).astype(np.float32)


def load_rgb(input_path: Path) -> np.ndarray:
    """Load images deterministically and alpha-composite transparency over black."""
    with Image.open(input_path) as source:
        rgba = source.convert("RGBA")
        data = np.asarray(rgba, dtype=np.float32)
    alpha = data[:, :, 3:4] / 255.0
    rgb = np.rint(data[:, :, :3] * alpha).astype(np.uint8)
    return rgb


def extract_features(rgb: np.ndarray) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    height, width, _ = rgb.shape
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    gradient_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    edge_strength = np.sqrt(gradient_x**2 + gradient_y**2).astype(np.float32)

    yy, xx = np.mgrid[0:height, 0:width]
    feature_tensor = np.stack(
        [
            normalize_unit(xx.astype(np.float32)),
            normalize_unit(yy.astype(np.float32)),
            rgb[:, :, 0].astype(np.float32) / 255.0,
            rgb[:, :, 1].astype(np.float32) / 255.0,
            rgb[:, :, 2].astype(np.float32) / 255.0,
            gray,
            gradient_x,
            gradient_y,
            edge_strength,
        ],
        axis=-1,
    ).astype(np.float32)
    return feature_tensor, {
        "brightness": gray,
        "gradient_x": gradient_x,
        "gradient_y": gradient_y,
        "edge_strength": edge_strength,
    }


def merge_tiny_regions(labels: np.ndarray, minimum_pixels: int) -> np.ndarray:
    """Merge undersized labels into their most frequent adjacent neighbour."""
    labels = labels.astype(np.int32).copy()
    counts = np.bincount(labels.ravel())
    for label in range(1, len(counts)):
        if counts[label] == 0 or counts[label] >= minimum_pixels:
            continue
        mask = labels == label
        neighbourhood = binary_dilation(mask) & ~mask
        neighbors = labels[neighbourhood]
        neighbors = neighbors[neighbors != label]
        if neighbors.size == 0:
            continue
        neighbor_counts = np.bincount(neighbors)
        replacement = int(np.flatnonzero(neighbor_counts == neighbor_counts.max())[0])
        if replacement > 0:
            labels[mask] = replacement
    relabeled, _, _ = relabel_sequential(labels)
    return relabeled.astype(np.int32)


class GroupingStrategy:
    """Extension point for deterministic region grouping methods."""

    name = "base"

    def segment(self, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
        raise NotImplementedError


class SLICGroupingStrategy(GroupingStrategy):
    name = "slic"

    def segment(self, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
        labels = slic(
            rgb,
            n_segments=max(8, int(requested_segments)),
            compactness=float(compactness),
            start_label=1,
            channel_axis=-1,
            enforce_connectivity=True,
            convert2lab=True,
        )
        return merge_tiny_regions(labels, minimum_pixels)


GROUPING_STRATEGIES: Dict[str, GroupingStrategy] = {SLICGroupingStrategy.name: SLICGroupingStrategy()}


def segment_image(method: str, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    strategy = GROUPING_STRATEGIES.get(method)
    if not strategy:
        raise ValueError(f"Unsupported grouping method: {method}.")
    return strategy.segment(rgb, requested_segments, compactness, minimum_pixels)


def mask_geometry(mask: np.ndarray) -> Tuple[List[int], List[float], float, float]:
    ys, xs = np.where(mask)
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())
    centroid = [round(float(xs.mean()), 4), round(float(ys.mean()), 4)]
    perimeter_value = round(float(mask_perimeter(mask, neighborhood=8)), 4)
    if len(xs) < 2:
        orientation = 0.0
    else:
        covariance = np.cov(np.vstack((xs, ys)))
        values, vectors = np.linalg.eigh(covariance)
        direction = vectors[:, int(np.argmax(values))]
        orientation = round(float(math.degrees(math.atan2(direction[1], direction[0]))), 4)
    return [min_x, min_y, max_x, max_y], centroid, perimeter_value, orientation


def member_pixels(mask: np.ndarray, scale_factor: int) -> List[List[int]]:
    ys, xs = np.where(mask)
    return [[int(x * scale_factor), int(y * scale_factor)] for y, x in zip(ys, xs)]


def make_entity(
    entity_id: str,
    entity_type: str,
    level: int,
    scale_factor: int,
    mask: np.ndarray,
    rgb: np.ndarray,
    brightness: np.ndarray,
    children: Iterable[str] | None = None,
    parent_id: str | None = None,
) -> Dict[str, Any]:
    bounding_box, centroid, perimeter_value, orientation = mask_geometry(mask)
    pixel_values = rgb[mask]
    mean_rgb = [round(float(value), 4) for value in pixel_values.mean(axis=0)]
    variance_rgb = [round(float(value), 4) for value in pixel_values.var(axis=0)]
    area = int(mask.sum())
    width = bounding_box[2] - bounding_box[0] + 1
    height = bounding_box[3] - bounding_box[1] + 1
    compactness = round((4 * math.pi * area) / max(perimeter_value * perimeter_value, 1e-9), 6)
    return {
        "id": entity_id,
        "type": entity_type,
        "level": level,
        "scaleFactor": scale_factor,
        "geometry": {
            "boundingBox": bounding_box,
            "centroid": centroid,
            "area": area,
            "perimeter": perimeter_value,
            "orientation": orientation,
            "compactness": compactness,
        },
        "appearance": {
            "meanRGB": mean_rgb,
            "brightness": round(float(brightness[mask].mean()), 6),
            "varianceRGB": variance_rgb,
        },
        "statistics": {"memberPixelCount": area},
        "memberPixels": member_pixels(mask, scale_factor),
        "children": list(children or []),
        "parentId": parent_id,
        "crossScaleParentId": None,
    }


def label_adjacency(labels: np.ndarray) -> set[Tuple[int, int]]:
    pairs: set[Tuple[int, int]] = set()
    for first, second in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        different = first != second
        for a, b in zip(first[different], second[different]):
            pairs.add((int(min(a, b)), int(max(a, b))))
    return pairs


def overlap_ratio(first: np.ndarray, second: np.ndarray) -> float:
    intersection = int(np.logical_and(first, second).sum())
    union = int(np.logical_or(first, second).sum())
    return round(intersection / union, 8) if union else 0.0


def containment_relation(first: np.ndarray, second: np.ndarray) -> str:
    """Return the directional containment state for arbitrary masks."""
    first_area = int(first.sum())
    second_area = int(second.sum())
    if first_area and first_area < second_area and np.logical_and(first, ~second).sum() == 0:
        return "source_in_target"
    if second_area and second_area < first_area and np.logical_and(second, ~first).sum() == 0:
        return "target_in_source"
    return "none"


def build_relationships(
    entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], adjacency_pairs: set[Tuple[int, int]], label_by_id: Dict[str, int], image_diagonal: float
) -> List[Dict[str, Any]]:
    relationships: List[Dict[str, Any]] = []
    for source_index, source in enumerate(entities):
        for target in entities[source_index + 1 :]:
            source_centroid = source["geometry"]["centroid"]
            target_centroid = target["geometry"]["centroid"]
            delta_x = target_centroid[0] - source_centroid[0]
            delta_y = target_centroid[1] - source_centroid[1]
            distance = math.hypot(delta_x, delta_y)
            source_area = source["geometry"]["area"]
            target_area = target["geometry"]["area"]
            source_mean = source["appearance"]["meanRGB"]
            target_mean = target["appearance"]["meanRGB"]
            labels = (label_by_id.get(source["id"]), label_by_id.get(target["id"]))
            adjacent = tuple(sorted(labels)) in adjacency_pairs if None not in labels else bool(np.logical_and(binary_dilation(masks[source["id"]]), masks[target["id"]]).any())
            relationship = {
                "sourceId": source["id"],
                "targetId": target["id"],
                "entityLevel": source["level"],
                "distance": round(distance, 6),
                "normalizedDistance": round(distance / max(image_diagonal, 1e-9), 8),
                "angle": round(math.degrees(math.atan2(delta_y, delta_x)), 6),
                "sizeRatio": round(source_area / max(target_area, 1e-9), 8),
                "colorDifference": round(float(np.linalg.norm(np.subtract(source_mean, target_mean))), 6),
                "brightnessDifference": round(abs(source["appearance"]["brightness"] - target["appearance"]["brightness"]), 8),
                "adjacent": adjacent,
                "overlap": overlap_ratio(masks[source["id"]], masks[target["id"]]),
                "containment": containment_relation(masks[source["id"]], masks[target["id"]]),
            }
            relationships.append(relationship)
    return relationships


def make_parent_groups(
    children: List[Dict[str, Any]],
    masks: Dict[str, np.ndarray],
    rgb: np.ndarray,
    brightness: np.ndarray,
    entity_type: str,
    level: int,
    group_size: int,
    prefix: str,
) -> List[Dict[str, Any]]:
    ordered = sorted(children, key=lambda item: (item["geometry"]["centroid"][1], item["geometry"]["centroid"][0], item["id"]))
    parents: List[Dict[str, Any]] = []
    for index in range(0, len(ordered), group_size):
        group = ordered[index : index + group_size]
        if not group:
            continue
        entity_id = f"{prefix}-{index // group_size + 1}"
        group_mask = np.zeros_like(next(iter(masks.values())), dtype=bool)
        child_ids: List[str] = []
        for child in group:
            group_mask |= masks[child["id"]]
            child["parentId"] = entity_id
            child_ids.append(child["id"])
        masks[entity_id] = group_mask
        parents.append(make_entity(entity_id, entity_type, level, 1, group_mask, rgb, brightness, child_ids))
    return parents


def create_svg(labels: np.ndarray, rgb: np.ndarray, output_path: Path) -> None:
    height, width = labels.shape
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Segmented region boundaries">']
    for label in range(1, int(labels.max()) + 1):
        mask = labels == label
        pixels = rgb[mask]
        color = tuple(int(round(v)) for v in pixels.mean(axis=0))
        contours = find_contours(mask.astype(float), 0.5)
        if not contours:
            continue
        contour = max(contours, key=len)[:: max(1, len(max(contours, key=len)) // 72)]
        points = " ".join(f"{point[1]:.2f},{point[0]:.2f}" for point in contour)
        parts.append(f'<polygon id="microregion-{label}" points="{points}" fill="rgb{color}" stroke="#09111f" stroke-width="0.7"/>')
    parts.append("</svg>")
    output_path.write_text("\n".join(parts), encoding="utf-8")


def write_overlay(values: np.ndarray, output_path: Path, colormap: int = cv2.COLORMAP_TURBO) -> None:
    image = (normalize_unit(values) * 255).astype(np.uint8)
    colored = cv2.applyColorMap(image, colormap)
    cv2.imwrite(str(output_path), colored)


def resize_image(rgb: np.ndarray, factor: int) -> np.ndarray:
    if factor == 1:
        return rgb
    height, width = rgb.shape[:2]
    return cv2.resize(rgb, (max(2, width // factor), max(2, height // factor)), interpolation=cv2.INTER_AREA)


def analyze(input_path: Path, output_dir: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    started = time.perf_counter()
    output_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(input_path) as probe:
        width_probe, height_probe = probe.size
    if width_probe * height_probe > int(config["maxImagePixels"]):
        raise ValueError(f"The image exceeds the configured {config['maxImagePixels']:,}-pixel analysis ceiling.")
    rgb = load_rgb(input_path)
    height, width = rgb.shape[:2]
    feature_tensor, feature_maps = extract_features(rgb)
    scale_factors = sorted(set(int(value) for value in config["scaleLevels"] if int(value) >= 1))
    if 1 not in scale_factors:
        scale_factors.insert(0, 1)

    np.savez_compressed(
        output_dir / "features.npz",
        featureTensor=feature_tensor,
        featureChannels=np.array(FEATURE_CHANNELS),
        **feature_maps,
    )

    overlays_dir = output_dir / "overlays"
    overlays_dir.mkdir(exist_ok=True)
    write_overlay(feature_maps["brightness"], overlays_dir / "brightness.png", cv2.COLORMAP_VIRIDIS)
    write_overlay(feature_maps["edge_strength"], overlays_dir / "edge-strength.png", cv2.COLORMAP_INFERNO)
    write_overlay(feature_maps["gradient_x"], overlays_dir / "gradient-x.png", cv2.COLORMAP_COOL)
    write_overlay(feature_maps["gradient_y"], overlays_dir / "gradient-y.png", cv2.COLORMAP_COOL)

    scale_levels: List[Dict[str, Any]] = []
    scale_regions: Dict[int, List[Dict[str, Any]]] = {}
    all_entities: List[Dict[str, Any]] = []
    base_masks: Dict[str, np.ndarray] = {}
    base_label_by_id: Dict[str, int] = {}
    base_labels: np.ndarray | None = None
    base_adjacency: set[Tuple[int, int]] = set()

    for factor in scale_factors:
        scaled_rgb = resize_image(rgb, factor)
        scaled_features, scaled_maps = extract_features(scaled_rgb)
        target_segments = max(8, int(config["slicSegments"] / (factor * factor)))
        labels = segment_image(
            config["groupingMethod"],
            scaled_rgb,
            target_segments,
            config["slicCompactness"],
            config["minimumRegionPixels"],
        )
        current_entities: List[Dict[str, Any]] = []
        for label in range(1, int(labels.max()) + 1):
            entity_id = f"scale-{factor}-microregion-{label}"
            mask = labels == label
            entity = make_entity(entity_id, "microregion", 1, factor, mask, scaled_rgb, scaled_maps["brightness"])
            current_entities.append(entity)
            all_entities.append(entity)
            if factor == 1:
                base_masks[entity_id] = mask
                base_label_by_id[entity_id] = label
        scale_regions[factor] = current_entities
        scale_levels.append(
            {
                "scaleFactor": factor,
                "width": int(scaled_rgb.shape[1]),
                "height": int(scaled_rgb.shape[0]),
                "featureShape": list(scaled_features.shape),
                "entityIds": [item["id"] for item in current_entities],
                "crossScaleLinks": [],
            }
        )
        if factor == 1:
            base_labels = labels
            base_adjacency = label_adjacency(labels)

    # Connect every scale's microregions to a deterministic parent in the next coarser scale.
    for current_index, factor in enumerate(scale_factors[:-1]):
        parent_factor = scale_factors[current_index + 1]
        parent_entities = scale_regions[parent_factor]
        for entity in scale_regions[factor]:
            x, y = entity["geometry"]["centroid"]
            reference_x, reference_y = x / parent_factor * factor, y / parent_factor * factor
            parent = min(
                parent_entities,
                key=lambda candidate: math.hypot(candidate["geometry"]["centroid"][0] - reference_x, candidate["geometry"]["centroid"][1] - reference_y),
            )
            entity["crossScaleParentId"] = parent["id"]
            scale_levels[current_index]["crossScaleLinks"].append({"childId": entity["id"], "parentId": parent["id"]})

    if base_labels is None:
        raise RuntimeError("The required 1× analysis scale was not created.")

    # Every source pixel maps to one 1× microregion label in this dense array.
    # It is the first-class pixel-level hierarchy without allocating millions
    # of per-pixel Python or JSON entities.
    np.savez_compressed(
        output_dir / "features.npz",
        featureTensor=feature_tensor,
        featureChannels=np.array(FEATURE_CHANNELS),
        pixelToMicroregion=base_labels,
        **feature_maps,
    )

    base_microregions = scale_regions[1]
    regions = make_parent_groups(base_microregions, base_masks, rgb, feature_maps["brightness"], "region", 2, config["hierarchyGroupSize"], "region")
    parts = make_parent_groups(regions, base_masks, rgb, feature_maps["brightness"], "part", 3, config["hierarchyGroupSize"], "part")
    object_candidates = make_parent_groups(parts, base_masks, rgb, feature_maps["brightness"], "object_candidate", 4, config["hierarchyGroupSize"], "object")

    root_mask = np.ones((height, width), dtype=bool)
    root = make_entity("image-root", "image", 5, 1, root_mask, rgb, feature_maps["brightness"], [item["id"] for item in object_candidates])
    for entity in object_candidates:
        entity["parentId"] = root["id"]
    all_entities.extend(regions + parts + object_candidates + [root])

    image_diagonal = math.hypot(width, height)
    relationships = build_relationships(base_microregions, base_masks, base_adjacency, base_label_by_id, image_diagonal)
    relationships.extend(build_relationships(regions, base_masks, set(), {}, image_diagonal))
    relationships.extend(build_relationships(parts, base_masks, set(), {}, image_diagonal))
    relationships.extend(build_relationships(object_candidates, base_masks, set(), {}, image_diagonal))
    reconstructed = np.zeros_like(rgb)
    for entity in base_microregions:
        color = np.rint(np.array(entity["appearance"]["meanRGB"])).astype(np.uint8)
        reconstructed[base_masks[entity["id"]]] = color
    Image.fromarray(reconstructed, mode="RGB").save(output_dir / "reconstructed.png")
    create_svg(base_labels, rgb, output_dir / "reconstruction.svg")

    source_bytes = input_path.stat().st_size
    mse = float(np.mean((rgb.astype(np.float32) - reconstructed.astype(np.float32)) ** 2))
    min_dimension = min(height, width)
    ssim_window = max(3, min(7, min_dimension if min_dimension % 2 == 1 else min_dimension - 1))
    ssim = structural_similarity(rgb, reconstructed, channel_axis=2, data_range=255, win_size=ssim_window)
    psnr_value = 99.0 if mse <= 1e-12 else float(peak_signal_noise_ratio(rgb, reconstructed, data_range=255))
    # JSON does not allow Infinity. An exact reconstruction is represented as
    # a capped 99 dB value with an explicit marker for downstream consumers.
    psnr = 99.0 if not math.isfinite(psnr_value) else psnr_value

    representation: Dict[str, Any] = {
        "version": "1.0.0",
        "coordinateSystem": "pixel coordinates are [x, y]; boundingBox is [minX, minY, maxX, maxY], inclusive",
        "configuration": config,
        "image": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes},
        "features": {
            "shape": list(feature_tensor.shape),
            "channels": FEATURE_CHANNELS,
            "artifact": "features.npz",
        },
        "pixelLevel": {
            "assignmentArtifact": "features.npz",
            "assignmentKey": "pixelToMicroregion",
            "labelToMicroregionId": {str(label): f"scale-1-microregion-{label}" for label in range(1, int(base_labels.max()) + 1)},
        },
        "scaleLevels": scale_levels,
        "hierarchy": {
            "levels": {"pixel": 0, "microregion": 1, "region": 2, "part": 3, "object_candidate": 4},
            "rootId": root["id"],
        },
        "entities": all_entities,
        "relationships": relationships,
        "artifacts": {
            "features": "features.npz",
            "reconstructedPng": "reconstructed.png",
            "svg": "reconstruction.svg",
            "overlays": {
                "brightness": "overlays/brightness.png",
                "edgeStrength": "overlays/edge-strength.png",
                "gradientX": "overlays/gradient-x.png",
                "gradientY": "overlays/gradient-y.png",
            },
        },
        "metrics": {
            "mse": round(mse, 8),
            "psnr": round(float(psnr), 6),
            "psnrExactReconstruction": mse <= 1e-12,
            "ssim": round(float(ssim), 8),
            "sourceBytes": source_bytes,
            "representationBytes": 0,
            "reconstructedBytes": 0,
            "compressionRatio": 0,
            "processingTimeMs": 0,
        },
    }
    representation_path = output_dir / "representation.json"
    representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    representation["metrics"]["representationBytes"] = representation_path.stat().st_size + (output_dir / "features.npz").stat().st_size
    representation["metrics"]["reconstructedBytes"] = (output_dir / "reconstructed.png").stat().st_size
    representation["metrics"]["compressionRatio"] = round(source_bytes / max(representation["metrics"]["representationBytes"], 1), 8)
    representation["metrics"]["processingTimeMs"] = round((time.perf_counter() - started) * 1000, 3)
    representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    return {"representationPath": str(representation_path), "entityCount": len(all_entities), "relationshipCount": len(relationships)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args()
    result = analyze(Path(arguments.input), Path(arguments.output), json.loads(arguments.config))
    print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    main()

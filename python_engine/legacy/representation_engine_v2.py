#!/usr/bin/env python3
"""Relational hierarchical image representation engine, schema version 0.2.0.

The engine keeps dense pixel arithmetic in NumPy tensors and emits only sparse
entities and relationship edges for inspection. It is invoked only by the Node
server, writes artifacts to a supplied workspace, and prints one JSON envelope.
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
from scipy.ndimage import binary_dilation, uniform_filter
from scipy.spatial import cKDTree
from skimage.measure import find_contours, perimeter as mask_perimeter
from skimage.metrics import peak_signal_noise_ratio, structural_similarity
from skimage.segmentation import relabel_sequential, slic


PIXEL_VECTOR_FIELDS = [
    "x", "y", "red", "green", "blue", "brightness", "saturation", "hue",
    "gradient_x", "gradient_y", "gradient_magnitude", "edge_strength", "local_variance", "complexity",
]
REGION_VECTOR_FIELDS = [
    "centroid_x", "centroid_y", "bbox_x", "bbox_y", "bbox_width", "bbox_height", "area", "perimeter",
    "compactness", "orientation", "mean_r", "mean_g", "mean_b", "color_variance", "mean_brightness",
    "brightness_variance", "mean_gradient", "edge_density", "texture_measure", "child_count",
]
EPSILON = 1e-9


def round_number(value: float, digits: int = 8) -> float:
    return round(float(value), digits)


def normalize_unit(values: np.ndarray) -> np.ndarray:
    minimum, maximum = float(values.min()), float(values.max())
    if maximum - minimum <= EPSILON:
        return np.zeros_like(values, dtype=np.float32)
    return ((values - minimum) / (maximum - minimum)).astype(np.float32)


def load_rgb(input_path: Path) -> np.ndarray:
    with Image.open(input_path) as source:
        rgba = np.asarray(source.convert("RGBA"), dtype=np.float32)
    alpha = rgba[:, :, 3:4] / 255.0
    return np.rint(rgba[:, :, :3] * alpha).astype(np.uint8)


def extract_features(rgb: np.ndarray) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    height, width, _ = rgb.shape
    rgb_unit = rgb.astype(np.float32) / 255.0
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    brightness = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    gradient_x = cv2.Sobel(brightness, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(brightness, cv2.CV_32F, 0, 1, ksize=3)
    gradient_magnitude = np.sqrt(gradient_x**2 + gradient_y**2).astype(np.float32)
    edge_strength = (cv2.Canny((brightness * 255).astype(np.uint8), 64, 128).astype(np.float32) / 255.0)
    local_mean = uniform_filter(brightness, size=5, mode="reflect")
    local_variance = np.maximum(uniform_filter(brightness**2, size=5, mode="reflect") - local_mean**2, 0).astype(np.float32)
    complexity = normalize_unit(
        0.45 * normalize_unit(gradient_magnitude) + 0.25 * normalize_unit(local_variance) + 0.30 * edge_strength
    )
    yy, xx = np.mgrid[0:height, 0:width]
    fields = {
        "x": normalize_unit(xx.astype(np.float32)),
        "y": normalize_unit(yy.astype(np.float32)),
        "red": rgb_unit[:, :, 0],
        "green": rgb_unit[:, :, 1],
        "blue": rgb_unit[:, :, 2],
        "brightness": brightness,
        "saturation": hsv[:, :, 1] / 255.0,
        "hue": hsv[:, :, 0] / 179.0,
        "gradient_x": gradient_x,
        "gradient_y": gradient_y,
        "gradient_magnitude": gradient_magnitude,
        "edge_strength": edge_strength,
        "local_variance": local_variance,
        "complexity": complexity,
    }
    return np.stack([fields[name] for name in PIXEL_VECTOR_FIELDS], axis=-1).astype(np.float32), fields


def merge_tiny_regions(labels: np.ndarray, minimum_pixels: int) -> np.ndarray:
    labels = labels.astype(np.int32).copy()
    counts = np.bincount(labels.ravel())
    for label in range(1, len(counts)):
        if not counts[label] or counts[label] >= minimum_pixels:
            continue
        mask = labels == label
        neighbors = labels[binary_dilation(mask) & ~mask]
        neighbors = neighbors[neighbors != label]
        if neighbors.size:
            frequency = np.bincount(neighbors)
            replacement = int(np.flatnonzero(frequency == frequency.max())[0])
            if replacement:
                labels[mask] = replacement
    relabeled, _, _ = relabel_sequential(labels)
    return relabeled.astype(np.int32)


class GroupingStrategy:
    name = "base"

    def segment(self, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
        raise NotImplementedError


class AdaptiveSLICGroupingStrategy(GroupingStrategy):
    name = "slic"

    def segment(self, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
        _, fields = extract_features(rgb)
        complexity = fields["complexity"]
        high_information_fraction = float((complexity >= np.quantile(complexity, 0.75)).mean())
        complexity_multiplier = 1.0 + min(0.75, float(complexity.mean()) * 0.45 + high_information_fraction * 0.35)
        adaptive_segments = max(8, int(round(requested_segments * complexity_multiplier)))
        labels = slic(
            rgb,
            n_segments=adaptive_segments,
            compactness=float(compactness),
            start_label=1,
            channel_axis=-1,
            enforce_connectivity=True,
            convert2lab=True,
        )
        minimum_expected = max(2, adaptive_segments // 8)
        if int(labels.max()) < minimum_expected and float(complexity.mean()) >= 0.35:
            # SLIC can collapse fragmented high-frequency inputs during
            # connectivity enforcement. Preserve deterministic local capacity
            # with a complexity-triggered spatial refinement fallback.
            height, width = rgb.shape[:2]
            columns = max(2, int(math.ceil(math.sqrt(adaptive_segments * width / max(height, 1)))))
            rows = max(2, int(math.ceil(adaptive_segments / columns)))
            yy, xx = np.mgrid[0:height, 0:width]
            labels = ((yy * rows // height) * columns + (xx * columns // width) + 1).astype(np.int32)
        return merge_tiny_regions(labels, minimum_pixels)


GROUPING_STRATEGIES: Dict[str, GroupingStrategy] = {AdaptiveSLICGroupingStrategy.name: AdaptiveSLICGroupingStrategy()}


def segment_image(method: str, rgb: np.ndarray, requested_segments: int, compactness: float, minimum_pixels: int) -> np.ndarray:
    strategy = GROUPING_STRATEGIES.get(method)
    if not strategy:
        raise ValueError(f"Unsupported grouping method: {method}.")
    return strategy.segment(rgb, requested_segments, compactness, minimum_pixels)


def mask_geometry(mask: np.ndarray) -> Tuple[List[int], List[float], float, float]:
    ys, xs = np.where(mask)
    min_x, max_x, min_y, max_y = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    centroid = [round_number(xs.mean(), 4), round_number(ys.mean(), 4)]
    perimeter_value = round_number(mask_perimeter(mask, neighborhood=8), 4)
    if len(xs) < 2:
        orientation = 0.0
    else:
        values, vectors = np.linalg.eigh(np.cov(np.vstack((xs, ys))))
        direction = vectors[:, int(np.argmax(values))]
        orientation = round_number(math.degrees(math.atan2(direction[1], direction[0])), 4)
    return [min_x, min_y, max_x, max_y], centroid, perimeter_value, orientation


def member_pixels(mask: np.ndarray, scale_factor: int) -> List[List[int]]:
    ys, xs = np.where(mask)
    return [[int(x * scale_factor), int(y * scale_factor)] for y, x in zip(ys, xs)]


def vector_payload(values: List[float], provenance: str, aggregation: str) -> Dict[str, Any]:
    return {
        "schema": "RegionVector@0.2",
        "dimension": len(REGION_VECTOR_FIELDS),
        "values": [round_number(value, 8) for value in values],
        "provenance": provenance,
        "aggregation": aggregation,
    }


def direct_region_vector(mask: np.ndarray, geometry: Dict[str, Any], rgb: np.ndarray, features: Dict[str, np.ndarray], child_count: int = 0) -> Tuple[List[float], Dict[str, float]]:
    box = geometry["boundingBox"]
    width, height = box[2] - box[0] + 1, box[3] - box[1] + 1
    area, perimeter = geometry["area"], geometry["perimeter"]
    pixels = rgb[mask].astype(np.float32)
    mean_rgb = pixels.mean(axis=0)
    color_variance = float(pixels.var(axis=0).mean())
    brightness = features["brightness"][mask]
    mean_gradient = float(features["gradient_magnitude"][mask].mean())
    edge_density = float(features["edge_strength"][mask].mean())
    texture = float(features["local_variance"][mask].mean())
    values = [
        geometry["centroid"][0], geometry["centroid"][1], box[0], box[1], width, height, area, perimeter,
        geometry["compactness"], geometry["orientation"], mean_rgb[0], mean_rgb[1], mean_rgb[2], color_variance,
        float(brightness.mean()), float(brightness.var()), mean_gradient, edge_density, texture, child_count,
    ]
    appearance = {
        "meanRGB": [round_number(value, 4) for value in mean_rgb],
        "brightness": round_number(brightness.mean(), 6),
        "varianceRGB": [round_number(value, 4) for value in pixels.var(axis=0)],
        "brightnessVariance": round_number(brightness.var(), 8),
        "meanGradient": round_number(mean_gradient, 8),
        "edgeDensity": round_number(edge_density, 8),
        "textureMeasure": round_number(texture, 8),
    }
    return values, appearance


def make_entity(entity_id: str, entity_type: str, level: int, scale_factor: int, mask: np.ndarray, rgb: np.ndarray, features: Dict[str, np.ndarray], children: Iterable[str] | None = None) -> Dict[str, Any]:
    box, centroid, perimeter, orientation = mask_geometry(mask)
    area = int(mask.sum())
    compactness = round_number((4 * math.pi * area) / max(perimeter * perimeter, EPSILON), 6)
    geometry = {"boundingBox": box, "centroid": centroid, "area": area, "perimeter": perimeter, "orientation": orientation, "compactness": compactness}
    child_ids = list(children or [])
    values, appearance = direct_region_vector(mask, geometry, rgb, features, len(child_ids))
    return {
        "id": entity_id,
        "type": entity_type,
        "level": level,
        "scaleFactor": scale_factor,
        "geometry": geometry,
        "appearance": appearance,
        "statistics": {"memberPixelCount": area, "complexity": round_number(features["complexity"][mask].mean(), 8)},
        "vector": vector_payload(values, "pixel_aggregate", "mean/variance over dense pixel fields"),
        "memberPixels": member_pixels(mask, scale_factor),
        "children": child_ids,
        "parentId": None,
        "crossScaleParentId": None,
    }


def derive_parent_vector(parent: Dict[str, Any], children: List[Dict[str, Any]]) -> Dict[str, Any]:
    weights = np.array([max(child["geometry"]["area"], 1) for child in children], dtype=np.float64)
    values = np.array([child["vector"]["values"] for child in children], dtype=np.float64)
    weighted = np.average(values, axis=0, weights=weights)
    child_boxes = np.array([child["geometry"]["boundingBox"] for child in children], dtype=np.float64)
    child_angles = np.deg2rad([child["geometry"]["orientation"] for child in children])
    weighted[0:2] = np.average(values[:, 0:2], axis=0, weights=weights)
    min_x, min_y = child_boxes[:, 0].min(), child_boxes[:, 1].min()
    max_x, max_y = child_boxes[:, 2].max(), child_boxes[:, 3].max()
    weighted[2:8] = [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1, weights.sum(), values[:, 7].sum()]
    weighted[9] = math.degrees(math.atan2(np.average(np.sin(child_angles), weights=weights), np.average(np.cos(child_angles), weights=weights)))
    weighted[19] = len(children)
    parent["vector"] = vector_payload(weighted.tolist(), "children_recursive_aggregate", "area-weighted means; union bbox; summed area/perimeter; circular orientation; child-count")
    parent["statistics"]["childAreaDistribution"] = {
        "min": round_number(weights.min(), 4), "max": round_number(weights.max(), 4), "mean": round_number(weights.mean(), 4), "variance": round_number(weights.var(), 4)
    }
    return parent


def label_adjacency(labels: np.ndarray) -> set[Tuple[int, int]]:
    pairs: set[Tuple[int, int]] = set()
    for first, second in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
        different = first != second
        for a, b in zip(first[different], second[different]):
            pairs.add((int(min(a, b)), int(max(a, b))))
    return pairs


def overlap_ratio(first: np.ndarray, second: np.ndarray) -> float:
    union = int(np.logical_or(first, second).sum())
    return float(np.logical_and(first, second).sum() / union) if union else 0.0


def containment_relation(first: np.ndarray, second: np.ndarray) -> str:
    first_area, second_area = int(first.sum()), int(second.sum())
    if first_area and first_area < second_area and not np.logical_and(first, ~second).any():
        return "source_in_target"
    if second_area and second_area < first_area and not np.logical_and(second, ~first).any():
        return "target_in_source"
    return "none"


def boundary_contact_ratio(first: np.ndarray, second: np.ndarray, source_perimeter: float, target_perimeter: float) -> float:
    contact = int(np.logical_and(binary_dilation(first), second).sum()) + int(np.logical_and(binary_dilation(second), first).sum())
    return float(contact / max(min(source_perimeter, target_perimeter), 1.0))


def relationship_candidates(entities: List[Dict[str, Any]], label_by_id: Dict[str, int], adjacency_pairs: set[Tuple[int, int]]) -> set[Tuple[int, int]]:
    count = len(entities)
    if count < 2:
        return set()
    candidates: set[Tuple[int, int]] = set()
    centroids = np.array([entity["geometry"]["centroid"] for entity in entities], dtype=np.float64)
    colors = np.array([entity["appearance"]["meanRGB"] for entity in entities], dtype=np.float64)
    for tree_data in (centroids, colors):
        tree = cKDTree(tree_data)
        _, neighbors = tree.query(tree_data, k=min(4, count))
        neighbors = np.atleast_2d(neighbors)
        for index, row in enumerate(neighbors):
            for candidate in row[1:]:
                if int(candidate) != index:
                    candidates.add((min(index, int(candidate)), max(index, int(candidate))))
    index_by_label = {label: index for index, entity in enumerate(entities) if (label := label_by_id.get(entity["id"])) is not None}
    for source_label, target_label in adjacency_pairs:
        if source_label in index_by_label and target_label in index_by_label:
            candidates.add((min(index_by_label[source_label], index_by_label[target_label]), max(index_by_label[source_label], index_by_label[target_label])))
    return candidates


def build_relationships(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], adjacency_pairs: set[Tuple[int, int]], label_by_id: Dict[str, int], image_width: int, image_height: int) -> List[Dict[str, Any]]:
    image_diagonal = math.hypot(image_width, image_height)
    relationships: List[Dict[str, Any]] = []
    for source_index, target_index in sorted(relationship_candidates(entities, label_by_id, adjacency_pairs)):
        source, target = entities[source_index], entities[target_index]
        source_center, target_center = source["geometry"]["centroid"], target["geometry"]["centroid"]
        dx, dy = target_center[0] - source_center[0], target_center[1] - source_center[1]
        distance = math.hypot(dx, dy)
        source_area, target_area = source["geometry"]["area"], target["geometry"]["area"]
        source_mask, target_mask = masks[source["id"]], masks[target["id"]]
        labels = (label_by_id.get(source["id"]), label_by_id.get(target["id"]))
        adjacent = tuple(sorted(labels)) in adjacency_pairs if None not in labels else bool(np.logical_and(binary_dilation(source_mask), target_mask).any())
        color_distance = float(np.linalg.norm(np.subtract(source["appearance"]["meanRGB"], target["appearance"]["meanRGB"])))
        color_similarity = max(0.0, 1.0 - color_distance / math.sqrt(3 * 255**2))
        shape_similarity = max(0.0, 1.0 - abs(source["geometry"]["compactness"] - target["geometry"]["compactness"]) - abs(source["geometry"]["orientation"] - target["geometry"]["orientation"]) / 360.0)
        brightness_difference = abs(source["appearance"]["brightness"] - target["appearance"]["brightness"])
        containment = containment_relation(source_mask, target_mask)
        overlap = overlap_ratio(source_mask, target_mask)
        relationship_types = []
        if adjacent: relationship_types.append("adjacent")
        if distance / max(image_diagonal, EPSILON) <= 0.22: relationship_types.append("near")
        if color_similarity >= 0.82: relationship_types.append("similar_color")
        if shape_similarity >= 0.80: relationship_types.append("similar_shape")
        if containment != "none": relationship_types.append(containment)
        if not relationship_types: relationship_types.append("related")
        confidence = min(1.0, 0.25 + 0.35 * float(adjacent) + 0.20 * color_similarity + 0.20 * shape_similarity)
        relationships.append({
            "sourceId": source["id"], "targetId": target["id"], "entityLevel": source["level"],
            "relationshipType": relationship_types, "primaryType": relationship_types[0],
            "distance": round_number(distance, 6), "normalizedDistance": round_number(distance / max(image_diagonal, EPSILON), 8),
            "dx": round_number(dx, 6), "dy": round_number(dy, 6), "angle": round_number(math.degrees(math.atan2(dy, dx)), 6),
            "normalizedDx": round_number(dx / max(image_width, 1), 8), "normalizedDy": round_number(dy / max(image_height, 1), 8),
            "sizeRatio": round_number(source_area / max(target_area, EPSILON), 8), "areaRatio": round_number(source_area / max(target_area, EPSILON), 8),
            "brightnessDifference": round_number(brightness_difference, 8), "brightnessRatio": round_number((source["appearance"]["brightness"] + EPSILON) / (target["appearance"]["brightness"] + EPSILON), 8),
            "colorDistance": round_number(color_distance, 6), "colorSimilarity": round_number(color_similarity, 8), "shapeSimilarity": round_number(shape_similarity, 8),
            "textureSimilarity": round_number(max(0.0, 1.0 - abs(source["appearance"]["textureMeasure"] - target["appearance"]["textureMeasure"])), 8),
            "overlapRatio": round_number(overlap, 8), "boundaryContactRatio": round_number(boundary_contact_ratio(source_mask, target_mask, source["geometry"]["perimeter"], target["geometry"]["perimeter"]), 8),
            "containment": containment, "containmentRatio": round_number(float(np.logical_and(source_mask, target_mask).sum() / max(source_area, 1)), 8),
            "confidence": round_number(confidence, 8), "adjacent": adjacent,
        })
    return relationships


def make_parent_groups(children: List[Dict[str, Any]], masks: Dict[str, np.ndarray], rgb: np.ndarray, features: Dict[str, np.ndarray], entity_type: str, level: int, group_size: int, prefix: str) -> List[Dict[str, Any]]:
    ordered = sorted(children, key=lambda item: (item["geometry"]["centroid"][1], item["geometry"]["centroid"][0], item["id"]))
    parents: List[Dict[str, Any]] = []
    for index in range(0, len(ordered), group_size):
        group = ordered[index:index + group_size]
        mask = np.zeros_like(next(iter(masks.values())), dtype=bool)
        for child in group:
            mask |= masks[child["id"]]
        entity = make_entity(f"{prefix}-{index // group_size + 1}", entity_type, level, 1, mask, rgb, features, [child["id"] for child in group])
        derive_parent_vector(entity, group)
        for child in group:
            child["parentId"] = entity["id"]
        masks[entity["id"]] = mask
        parents.append(entity)
    return parents


def resize_image(rgb: np.ndarray, factor: int) -> np.ndarray:
    if factor == 1:
        return rgb
    height, width = rgb.shape[:2]
    return cv2.resize(rgb, (max(2, width // factor), max(2, height // factor)), interpolation=cv2.INTER_AREA)


def metrics_for(original: np.ndarray, reconstructed: np.ndarray) -> Dict[str, float]:
    mse = float(np.mean((original.astype(np.float32) - reconstructed.astype(np.float32)) ** 2))
    minimum = min(original.shape[:2])
    window = max(3, min(7, minimum if minimum % 2 else minimum - 1))
    ssim = 1.0 if minimum < 3 else float(structural_similarity(original, reconstructed, channel_axis=2, data_range=255, win_size=window))
    psnr = 99.0 if mse <= EPSILON else float(peak_signal_noise_ratio(original, reconstructed, data_range=255))
    return {"mse": round_number(mse, 8), "psnr": round_number(min(psnr, 99.0), 6), "ssim": round_number(ssim, 8)}


def reconstruct_entities(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], shape: Tuple[int, int, int]) -> np.ndarray:
    reconstructed = np.zeros(shape, dtype=np.uint8)
    for entity in entities:
        reconstructed[masks[entity["id"]]] = np.rint(np.array(entity["appearance"]["meanRGB"])).astype(np.uint8)
    return reconstructed


def create_svg(labels: np.ndarray, rgb: np.ndarray, output_path: Path) -> None:
    height, width = labels.shape
    polygons = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Micro-region boundaries">']
    for label in range(1, int(labels.max()) + 1):
        mask = labels == label
        contours = find_contours(mask.astype(float), 0.5)
        if not contours:
            continue
        contour = max(contours, key=len)
        contour = contour[::max(1, len(contour) // 96)]
        color = tuple(int(round(value)) for value in rgb[mask].mean(axis=0))
        points = " ".join(f"{point[1]:.2f},{point[0]:.2f}" for point in contour)
        polygons.append(f'<polygon id="micro-region-{label}" points="{points}" fill="rgb{color}" stroke="#09111f" stroke-width="0.7"/>')
    polygons.append("</svg>")
    output_path.write_text("\n".join(polygons), encoding="utf-8")


def write_overlay(values: np.ndarray, output_path: Path, colormap: int = cv2.COLORMAP_TURBO) -> None:
    cv2.imwrite(str(output_path), cv2.applyColorMap((normalize_unit(values) * 255).astype(np.uint8), colormap))


def write_relationship_overlay(rgb: np.ndarray, entities: List[Dict[str, Any]], relationships: List[Dict[str, Any]], output_path: Path, distance_coloring: bool = False) -> None:
    canvas = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR).copy()
    lookup = {entity["id"]: entity for entity in entities}
    for relationship in relationships:
        source, target = lookup.get(relationship["sourceId"]), lookup.get(relationship["targetId"])
        if not source or not target:
            continue
        point_a = tuple(int(round(value)) for value in source["geometry"]["centroid"])
        point_b = tuple(int(round(value)) for value in target["geometry"]["centroid"])
        if distance_coloring:
            color = (0, int(255 * (1 - relationship["normalizedDistance"])), int(255 * relationship["normalizedDistance"]))
        else:
            color = (70, 230, 70) if relationship["adjacent"] else (230, 170, 40)
        cv2.line(canvas, point_a, point_b, color, 1, cv2.LINE_AA)
    for entity in entities:
        point = tuple(int(round(value)) for value in entity["geometry"]["centroid"])
        cv2.circle(canvas, point, 2, (255, 255, 255), -1, cv2.LINE_AA)
    cv2.imwrite(str(output_path), canvas)


def scale_consistency(base_entities: List[Dict[str, Any]], rgb: np.ndarray, config: Dict[str, Any]) -> Dict[str, Any]:
    height, width = rgb.shape[:2]
    if height * width * 4 > int(config.get("maxConsistencyPixels", 1_200_000)):
        return {"status": "skipped", "reason": "2× experiment exceeds configured consistency pixel budget."}
    doubled = cv2.resize(rgb, (width * 2, height * 2), interpolation=cv2.INTER_CUBIC)
    _, doubled_features = extract_features(doubled)
    doubled_labels = segment_image(config["groupingMethod"], doubled, config["slicSegments"], config["slicCompactness"], config["minimumRegionPixels"])
    doubled_entities = [make_entity(f"scaled2x-micro-region-{label}", "micro_region", 1, 1, doubled_labels == label, doubled, doubled_features) for label in range(1, int(doubled_labels.max()) + 1)]
    original_centers = np.array([[entity["geometry"]["centroid"][0] / width, entity["geometry"]["centroid"][1] / height] for entity in base_entities])
    doubled_centers = np.array([[entity["geometry"]["centroid"][0] / (width * 2), entity["geometry"]["centroid"][1] / (height * 2)] for entity in doubled_entities])
    distances, matches = cKDTree(doubled_centers).query(original_centers, k=1)
    original_area = np.array([entity["geometry"]["area"] / (width * height) for entity in base_entities])
    doubled_area = np.array([doubled_entities[index]["geometry"]["area"] / (width * height * 4) for index in matches])
    original_brightness = np.array([entity["appearance"]["brightness"] for entity in base_entities])
    doubled_brightness = np.array([doubled_entities[index]["appearance"]["brightness"] for index in matches])
    original_color = np.array([entity["appearance"]["meanRGB"] for entity in base_entities])
    doubled_color = np.array([doubled_entities[index]["appearance"]["meanRGB"] for index in matches])
    if len(original_centers) > 1 and len(doubled_centers) > 1:
        original_near = cKDTree(original_centers).query(original_centers, k=2)[0][:, 1]
        doubled_near = cKDTree(doubled_centers).query(doubled_centers[matches], k=2)[0][:, 1]
        relationship_stability = float(np.mean(np.abs(original_near - doubled_near)))
    else:
        relationship_stability = 0.0
    return {
        "status": "completed", "scaledDimensions": [width * 2, height * 2], "matchedEntityCount": len(matches),
        "centroidStability": round_number(float(np.mean(distances)), 8), "sizeRatioStability": round_number(float(np.mean(np.abs(original_area - doubled_area))), 8),
        "brightnessStability": round_number(float(np.mean(np.abs(original_brightness - doubled_brightness))), 8), "colorStability": round_number(float(np.mean(np.linalg.norm(original_color - doubled_color, axis=1))), 8),
        "relationshipStability": round_number(relationship_stability, 8), "correspondenceMethod": "nearest normalized centroid",
    }


def analyze(input_path: Path, output_dir: Path, config: Dict[str, Any]) -> Dict[str, Any]:
    profile_start = time.perf_counter()
    profile: Dict[str, float] = {}
    output_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(input_path) as probe:
        width_probe, height_probe = probe.size
    if width_probe * height_probe > int(config["maxImagePixels"]):
        raise ValueError(f"The image exceeds the configured {config['maxImagePixels']:,}-pixel analysis ceiling.")
    rgb = load_rgb(input_path)
    height, width = rgb.shape[:2]
    feature_started = time.perf_counter()
    feature_tensor, features = extract_features(rgb)
    profile["featureExtractionMs"] = round_number((time.perf_counter() - feature_started) * 1000, 3)
    overlays_dir, recon_dir, error_dir = output_dir / "overlays", output_dir / "reconstructions", output_dir / "errors"
    overlays_dir.mkdir(exist_ok=True); recon_dir.mkdir(exist_ok=True); error_dir.mkdir(exist_ok=True)
    for name, map_name, colormap in (("brightness", "brightness", cv2.COLORMAP_VIRIDIS), ("edge-strength", "edge_strength", cv2.COLORMAP_INFERNO), ("gradient-x", "gradient_x", cv2.COLORMAP_COOL), ("gradient-y", "gradient_y", cv2.COLORMAP_COOL), ("complexity", "complexity", cv2.COLORMAP_TURBO)):
        write_overlay(features[map_name], overlays_dir / f"{name}.png", colormap)

    scale_factors = sorted(set(int(value) for value in config["scaleLevels"] if int(value) >= 1))
    if 1 not in scale_factors: scale_factors.insert(0, 1)
    scale_levels: List[Dict[str, Any]] = []
    scale_entities: Dict[int, List[Dict[str, Any]]] = {}
    base_masks: Dict[str, np.ndarray] = {}; base_labels: np.ndarray | None = None; base_label_by_id: Dict[str, int] = {}; base_adjacency: set[Tuple[int, int]] = set()
    segmentation_started = time.perf_counter()
    for factor in scale_factors:
        scaled_rgb = resize_image(rgb, factor)
        scaled_tensor, scaled_features = extract_features(scaled_rgb)
        requested_segments = max(8, int(config["slicSegments"] / (factor * factor)))
        labels = segment_image(config["groupingMethod"], scaled_rgb, requested_segments, config["slicCompactness"], config["minimumRegionPixels"])
        entities = []
        for label in range(1, int(labels.max()) + 1):
            entity_id = f"scale-{factor}-micro-region-{label}"
            entity = make_entity(entity_id, "micro_region", 1, factor, labels == label, scaled_rgb, scaled_features)
            entities.append(entity)
            if factor == 1:
                base_masks[entity_id] = labels == label; base_label_by_id[entity_id] = label
        scale_entities[factor] = entities
        scale_reconstruction = reconstruct_entities(entities, {entity["id"]: labels == index for index, entity in enumerate(entities, start=1)}, scaled_rgb.shape)
        scale_levels.append({
            "scaleFactor": factor, "width": int(scaled_rgb.shape[1]), "height": int(scaled_rgb.shape[0]), "featureShape": list(scaled_tensor.shape),
            "entityIds": [entity["id"] for entity in entities], "entityCount": len(entities), "crossScaleLinks": [],
            "segmentationCharacteristics": {"requestedSegments": requested_segments, "actualSegments": int(labels.max()), "meanComplexity": round_number(scaled_features["complexity"].mean(), 8), "highComplexityFraction": round_number(float((scaled_features["complexity"] >= np.quantile(scaled_features["complexity"], .75)).mean()), 8)},
            "reconstructionError": metrics_for(scaled_rgb, scale_reconstruction),
        })
        if factor == 1:
            base_labels = labels; base_adjacency = label_adjacency(labels)
    profile["segmentationMs"] = round_number((time.perf_counter() - segmentation_started) * 1000, 3)
    if base_labels is None: raise RuntimeError("The required 1× analysis scale was not created.")

    for current_index, factor in enumerate(scale_factors[:-1]):
        parent_factor, parent_entities = scale_factors[current_index + 1], scale_entities[scale_factors[current_index + 1]]
        for entity in scale_entities[factor]:
            x, y = entity["geometry"]["centroid"]
            parent = min(parent_entities, key=lambda candidate: math.hypot(candidate["geometry"]["centroid"][0] - x * factor / parent_factor, candidate["geometry"]["centroid"][1] - y * factor / parent_factor))
            entity["crossScaleParentId"] = parent["id"]
            scale_levels[current_index]["crossScaleLinks"].append({"childId": entity["id"], "parentId": parent["id"]})

    aggregation_started = time.perf_counter()
    micro_regions = scale_entities[1]
    regions = make_parent_groups(micro_regions, base_masks, rgb, features, "region", 2, config["hierarchyGroupSize"], "region")
    composites = make_parent_groups(regions, base_masks, rgb, features, "composite", 3, config["hierarchyGroupSize"], "composite")
    entities_level = make_parent_groups(composites, base_masks, rgb, features, "entity", 4, config["hierarchyGroupSize"], "entity")
    root_mask = np.ones((height, width), dtype=bool)
    root = make_entity("image-root", "image", 5, 1, root_mask, rgb, features, [entity["id"] for entity in entities_level])
    derive_parent_vector(root, entities_level)
    for entity in entities_level: entity["parentId"] = root["id"]
    all_entities = micro_regions + regions + composites + entities_level + [root]
    profile["aggregationMs"] = round_number((time.perf_counter() - aggregation_started) * 1000, 3)

    relationship_started = time.perf_counter()
    relationships = build_relationships(micro_regions, base_masks, base_adjacency, base_label_by_id, width, height)
    relationships += build_relationships(regions, base_masks, set(), {}, width, height)
    relationships += build_relationships(composites, base_masks, set(), {}, width, height)
    relationships += build_relationships(entities_level, base_masks, set(), {}, width, height)
    profile["relationshipConstructionMs"] = round_number((time.perf_counter() - relationship_started) * 1000, 3)
    write_relationship_overlay(rgb, micro_regions, relationships, overlays_dir / "relationship-graph.png")
    write_relationship_overlay(rgb, micro_regions, relationships, overlays_dir / "normalized-distance-graph.png", True)

    reconstruction_started = time.perf_counter()
    reconstruction_groups = {"level1": micro_regions, "level2": regions, "level3": composites, "level4": entities_level, "full": micro_regions}
    reconstruction_metadata: Dict[str, Any] = {}
    for key, group in reconstruction_groups.items():
        reconstruction = reconstruct_entities(group, base_masks, rgb.shape)
        output_name = f"{key}.png"
        Image.fromarray(reconstruction, mode="RGB").save(recon_dir / output_name)
        reconstruction_metadata[key] = {"artifact": f"reconstructions/{output_name}", "entityCount": len(group), **metrics_for(rgb, reconstruction)}
    full_reconstruction = reconstruct_entities(micro_regions, base_masks, rgb.shape)
    Image.fromarray(full_reconstruction, mode="RGB").save(output_dir / "reconstructed.png")
    absolute_error = np.abs(rgb.astype(np.float32) - full_reconstruction.astype(np.float32)).mean(axis=2)
    per_region_error = np.zeros((height, width), dtype=np.float32)
    for entity in micro_regions:
        per_region_error[base_masks[entity["id"]]] = float(absolute_error[base_masks[entity["id"]]].mean())
    write_overlay(absolute_error, error_dir / "absolute-error.png", cv2.COLORMAP_INFERNO)
    write_overlay(per_region_error, error_dir / "per-region-error.png", cv2.COLORMAP_MAGMA)
    create_svg(base_labels, rgb, output_dir / "reconstruction.svg")
    profile["reconstructionMs"] = round_number((time.perf_counter() - reconstruction_started) * 1000, 3)

    consistency_started = time.perf_counter()
    consistency = scale_consistency(micro_regions, rgb, config) if config.get("runScaleConsistency", True) else {"status": "disabled"}
    profile["scaleConsistencyMs"] = round_number((time.perf_counter() - consistency_started) * 1000, 3)
    np.savez_compressed(output_dir / "features.npz", pixelVectors=feature_tensor, pixelVectorFields=np.array(PIXEL_VECTOR_FIELDS), pixelToMicroregion=base_labels, **features)

    serialization_started = time.perf_counter()
    source_bytes = input_path.stat().st_size
    quality_metrics = {**metrics_for(rgb, full_reconstruction), "sourceBytes": source_bytes, "representationBytes": 0, "reconstructedBytes": 0, "representationOverhead": 0.0, "processingTimeMs": 0.0}
    representation: Dict[str, Any] = {
        "representation_version": "0.2.0", "version": "0.2.0", "coordinateSystem": "pixel coordinates are [x, y]; boundingBox is [minX, minY, maxX, maxY], inclusive",
        "image_metadata": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes}, "image": {"width": width, "height": height, "channels": 3, "sourceBytes": source_bytes}, "configuration": config,
        "feature_schema": {"PixelVector": {"fields": PIXEL_VECTOR_FIELDS, "shape": list(feature_tensor.shape), "storage": "features.npz:pixelVectors"}, "RegionVector": {"fields": REGION_VECTOR_FIELDS, "dimension": len(REGION_VECTOR_FIELDS), "storage": "entities[].vector.values"}},
        "features": {"shape": list(feature_tensor.shape), "channels": PIXEL_VECTOR_FIELDS, "artifact": "features.npz"},
        "pixelLevel": {"assignmentArtifact": "features.npz", "assignmentKey": "pixelToMicroregion", "labelToMicroregionId": {str(label): f"scale-1-micro-region-{label}" for label in range(1, int(base_labels.max()) + 1)}},
        "scales": scale_levels, "scaleLevels": scale_levels,
        "hierarchy": {"levels": {"pixel": 0, "micro_region": 1, "region": 2, "composite": 3, "entity": 4, "image": 5}, "rootId": root["id"]},
        "entities": all_entities, "relationships": relationships,
        "aggregation_methods": {"micro_region": "dense pixel mean/variance", "higher_levels": "recursive area-weighted child vectors with union bounding boxes and circular orientation aggregation"},
        "normalization_methods": {"normalizedDistance": "distance / image diagonal", "normalizedDx": "dx / image width", "normalizedDy": "dy / image height", "areaRatio": "source area / target area", "brightnessRatio": "(source brightness + epsilon) / (target brightness + epsilon)"},
        "graph_metadata": {"construction": "sparse union of region-adjacency edges, 3-nearest spatial edges, and 3-nearest color edges", "complexity": "O(N log N + E) per hierarchy level; pixels retain implicit 4-neighborhood connectivity in dense tensors"},
        "reconstruction_metadata": {"outputs": reconstruction_metadata, "errorArtifacts": {"absolutePixelError": "errors/absolute-error.png", "perRegionError": "errors/per-region-error.png"}},
        "scale_consistency": consistency, "profiling": profile,
        "artifacts": {"features": "features.npz", "reconstructedPng": "reconstructed.png", "svg": "reconstruction.svg", "reconstructions": {key: value["artifact"] for key, value in reconstruction_metadata.items()}, "errors": {"absolutePixelError": "errors/absolute-error.png", "perRegionError": "errors/per-region-error.png"}, "overlays": {"brightness": "overlays/brightness.png", "edgeStrength": "overlays/edge-strength.png", "gradientX": "overlays/gradient-x.png", "gradientY": "overlays/gradient-y.png", "complexity": "overlays/complexity.png", "relationshipGraph": "overlays/relationship-graph.png", "normalizedDistanceGraph": "overlays/normalized-distance-graph.png"}},
        "quality_metrics": quality_metrics, "metrics": quality_metrics,
    }
    representation_path = output_dir / "representation.json"
    representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    quality_metrics["representationBytes"] = representation_path.stat().st_size + (output_dir / "features.npz").stat().st_size
    quality_metrics["reconstructedBytes"] = (output_dir / "reconstructed.png").stat().st_size
    quality_metrics["representationOverhead"] = round_number(quality_metrics["representationBytes"] / max(source_bytes, 1), 6)
    quality_metrics["processingTimeMs"] = round_number((time.perf_counter() - profile_start) * 1000, 3)
    profile["serializationMs"] = round_number((time.perf_counter() - serialization_started) * 1000, 3)
    representation_path.write_text(json.dumps(representation, separators=(",", ":")), encoding="utf-8")
    return {"representationPath": str(representation_path), "entityCount": len(all_entities), "relationshipCount": len(relationships)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True); parser.add_argument("--output", required=True); parser.add_argument("--config", required=True)
    arguments = parser.parse_args()
    result = analyze(Path(arguments.input), Path(arguments.output), json.loads(arguments.config))
    print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    main()

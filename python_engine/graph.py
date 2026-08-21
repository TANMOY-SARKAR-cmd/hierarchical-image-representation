"""Sparse unified relationship graph and merge-affinity calculations."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Mapping, Set, Tuple

import numpy as np
from scipy.spatial import cKDTree

from geometry import EPSILON, rounded


def iou(first: np.ndarray, second: np.ndarray) -> float:
    union = int(np.logical_or(first, second).sum())
    return float(np.logical_and(first, second).sum() / union) if union else 0.0


def axial_difference(source: float, target: float) -> float:
    difference = abs(math.radians(source) - math.radians(target)) % math.pi
    return min(difference, math.pi - difference) / math.pi


def color_distance(source: Mapping[str, Any], target: Mapping[str, Any]) -> float:
    first = np.array(source["appearance"]["meanLab"], dtype=np.float64)
    second = np.array(target["appearance"]["meanLab"], dtype=np.float64)
    return float(np.linalg.norm(first - second))


def shape_similarity(source: Mapping[str, Any], target: Mapping[str, Any], weights: Mapping[str, float]) -> float:
    compactness = abs(source["geometry"]["compactness"] - target["geometry"]["compactness"])
    orientation = axial_difference(source["geometry"]["orientation"], target["geometry"]["orientation"])
    source_hu = np.array(source["shape"]["huMoments"], dtype=np.float64)
    target_hu = np.array(target["shape"]["huMoments"], dtype=np.float64)
    hu = min(float(np.linalg.norm(source_hu - target_hu)) / 25.0, 1.0)
    distance = weights["compactness"] * compactness + weights["orientation"] * orientation + weights["hu"] * hu
    return max(0.0, min(1.0, math.exp(-distance)))


def masks_touch(first: np.ndarray, second: np.ndarray) -> bool:
    return bool(
        np.logical_and(first[:, 1:], second[:, :-1]).any()
        or np.logical_and(second[:, 1:], first[:, :-1]).any()
        or np.logical_and(first[1:, :], second[:-1, :]).any()
        or np.logical_and(second[1:, :], first[:-1, :]).any()
    )


def candidate_pairs(entities: List[Dict[str, Any]], adjacency: Set[Tuple[str, str]], graph_k: int) -> Dict[Tuple[int, int], Set[str]]:
    sources: Dict[Tuple[int, int], Set[str]] = defaultdict(set)
    index_by_id = {entity["id"]: index for index, entity in enumerate(entities)}
    for source_id, target_id in adjacency:
        if source_id in index_by_id and target_id in index_by_id:
            key = tuple(sorted((index_by_id[source_id], index_by_id[target_id])))
            sources[key].add("adjacent")
    if len(entities) < 2:
        return sources
    centroid_data = np.array([entity["geometry"]["centroid"] for entity in entities], dtype=np.float64)
    appearance_data = np.array([entity["appearance"]["meanLab"] for entity in entities], dtype=np.float64)
    for matrix, reason in ((centroid_data, "spatial_knn"), (appearance_data, "appearance_knn")):
        _, neighbors = cKDTree(matrix).query(matrix, k=min(max(2, graph_k + 1), len(entities)))
        for index, row in enumerate(np.atleast_2d(neighbors)):
            for neighbor in np.atleast_1d(row)[1:]:
                other = int(neighbor)
                if index != other:
                    sources[tuple(sorted((index, other)))].add(reason)
    return sources


def relationship_for(source: Dict[str, Any], target: Dict[str, Any], source_mask: np.ndarray, target_mask: np.ndarray, image_shape: Tuple[int, int], sources: Iterable[str], shared_boundary: int, config: Dict[str, Any]) -> Dict[str, Any]:
    height, width = image_shape
    source_center, target_center = source["geometry"]["centroid"], target["geometry"]["centroid"]
    dx, dy = target_center[0] - source_center[0], target_center[1] - source_center[1]
    distance = math.hypot(dx, dy); normalized_distance = distance / max(math.hypot(width, height), EPSILON)
    source_area, target_area = source["geometry"]["area"], target["geometry"]["area"]
    lab_distance = color_distance(source, target)
    color_sigma = max(float(config.get("labDeltaESigma", 22.0)), EPSILON)
    color_similarity = math.exp(-(lab_distance * lab_distance) / (2 * color_sigma * color_sigma))
    brightness_difference = abs(source["appearance"]["brightness"] - target["appearance"]["brightness"])
    texture_similarity = math.exp(-abs(source["appearance"]["textureMeasure"] - target["appearance"]["textureMeasure"]) / 0.20)
    gradient_similarity = math.exp(-abs(source["appearance"]["meanGradient"] - target["appearance"]["meanGradient"]) / 0.30)
    descriptor_similarity = shape_similarity(source, target, config["shapeWeights"])
    boundary_ratio = shared_boundary / max(min(source["geometry"]["perimeter"], target["geometry"]["perimeter"]), 1.0)
    average_boundary_edge = float((source["appearance"]["edgeDensity"] + target["appearance"]["edgeDensity"]) / 2.0)
    spatial_similarity = math.exp(-(normalized_distance * normalized_distance) / (2 * 0.20 * 0.20))
    weights = config["groupingWeights"]
    affinity = (
        weights["space"] * spatial_similarity + weights["color"] * color_similarity + weights["brightness"] * math.exp(-brightness_difference / 0.20)
        + weights["texture"] * texture_similarity + weights["gradient"] * gradient_similarity + weights["shape"] * descriptor_similarity
        - weights["boundary"] * average_boundary_edge
    )
    complexity = (source["statistics"]["complexity"] * source_area + target["statistics"]["complexity"] * target_area) / max(source_area + target_area, 1)
    merge_affinity = max(0.0, min(1.0, affinity * (1.0 - config["complexityMergePenalty"] * complexity)))
    overlap = iou(source_mask, target_mask)
    adjacent = "adjacent" in sources or masks_touch(source_mask, target_mask)
    kinds: List[str] = []
    if adjacent: kinds.append("adjacent")
    if normalized_distance <= 0.22: kinds.append("near")
    if color_similarity >= 0.82: kinds.append("similar_color")
    if descriptor_similarity >= 0.80: kinds.append("similar_shape")
    if not kinds: kinds.append("related")
    confidence = min(1.0, max(0.0, 0.35 * merge_affinity + 0.30 * float(adjacent) + 0.20 * color_similarity + 0.15 * descriptor_similarity))
    return {
        "sourceId": source["id"], "targetId": target["id"], "entityLevel": source["level"], "candidateSources": sorted(sources),
        "relationshipType": kinds, "primaryType": kinds[0], "topology": {"adjacent": adjacent, "sharedBoundaryLength": shared_boundary},
        "symmetric": {"distance": rounded(distance, 8), "normalizedDistance": rounded(normalized_distance, 8), "colorDistanceDeltaE76": rounded(lab_distance, 8), "shapeSimilarity": rounded(descriptor_similarity, 8), "textureSimilarity": rounded(texture_similarity, 8), "overlapIoU": rounded(overlap, 8), "boundaryContactRatio": rounded(boundary_ratio, 8)},
        "directional": {"dx": rounded(dx, 8), "dy": rounded(dy, 8), "normalizedDx": rounded(dx / max(width, 1), 8), "normalizedDy": rounded(dy / max(height, 1), 8), "logAreaRatio": rounded(math.log((source_area + EPSILON) / (target_area + EPSILON)), 8), "brightnessDifference": rounded(brightness_difference, 8), "logBrightnessRatio": rounded(math.log((source["appearance"]["brightness"] + EPSILON) / (target["appearance"]["brightness"] + EPSILON)), 8)},
        "distance": rounded(distance, 8), "normalizedDistance": rounded(normalized_distance, 8), "angle": rounded(math.degrees(math.atan2(dy, dx)), 8), "normalizedDx": rounded(dx / max(width, 1), 8), "normalizedDy": rounded(dy / max(height, 1), 8),
        "sizeRatio": rounded(source_area / max(target_area, 1), 8), "areaRatio": rounded(source_area / max(target_area, 1), 8), "logAreaRatio": rounded(math.log((source_area + EPSILON) / (target_area + EPSILON)), 8),
        "brightnessDifference": rounded(brightness_difference, 8), "brightnessRatio": rounded((source["appearance"]["brightness"] + EPSILON) / (target["appearance"]["brightness"] + EPSILON), 8), "logBrightnessRatio": rounded(math.log((source["appearance"]["brightness"] + EPSILON) / (target["appearance"]["brightness"] + EPSILON)), 8),
        "colorDistance": rounded(lab_distance, 8), "colorDistanceUnits": "DeltaE76_CIELAB", "colorSimilarity": rounded(color_similarity, 8), "shapeSimilarity": rounded(descriptor_similarity, 8), "textureSimilarity": rounded(texture_similarity, 8), "gradientSimilarity": rounded(gradient_similarity, 8),
        "overlapRatio": rounded(overlap, 8), "boundaryContactRatio": rounded(boundary_ratio, 8), "containment": "none", "containmentRatio": 0.0,
        "affinity": rounded(max(0.0, min(1.0, affinity)), 8), "mergeAffinity": rounded(merge_affinity, 8), "confidence": rounded(confidence, 8), "adjacent": adjacent,
    }


def build_relationships(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], adjacency: Set[Tuple[str, str]], image_shape: Tuple[int, int], config: Dict[str, Any], shared_boundaries: Mapping[Tuple[str, str], int] | None = None) -> List[Dict[str, Any]]:
    links = candidate_pairs(entities, adjacency, int(config["graphK"]))
    relationships: List[Dict[str, Any]] = []
    for source_index, target_index in sorted(links):
        source, target = entities[source_index], entities[target_index]
        key = tuple(sorted((source["id"], target["id"])))
        relationships.append(relationship_for(source, target, masks[source["id"]], masks[target["id"]], image_shape, links[(source_index, target_index)], int((shared_boundaries or {}).get(key, 0)), config))
    return relationships


def containment_edge(parent: Dict[str, Any], child: Dict[str, Any]) -> Dict[str, Any]:
    return {"sourceId": parent["id"], "targetId": child["id"], "entityLevel": parent["level"], "candidateSources": ["hierarchy"], "relationshipType": ["contains"], "primaryType": "contains", "directional": True, "containment": "source_contains_target", "containmentRatio": 1.0, "confidence": 1.0, "affinity": 1.0, "mergeAffinity": 1.0, "adjacent": False}

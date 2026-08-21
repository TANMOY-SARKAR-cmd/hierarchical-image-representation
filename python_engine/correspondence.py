"""Cross-resolution matching using IoU, normalized geometry, appearance, and area costs."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from geometry import rounded


def lifted_mask(mask: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
    return cv2.resize(mask.astype(np.uint8), (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)


def match_scales(base_entities: List[Dict[str, Any]], base_masks: Dict[str, np.ndarray], coarse_entities: List[Dict[str, Any]], coarse_masks: Dict[str, np.ndarray], factor: int, shape: Tuple[int, int]) -> List[Dict[str, Any]]:
    if not base_entities or not coarse_entities:
        return []
    height, width = shape; diagonal = math.hypot(width, height)
    costs = np.zeros((len(base_entities), len(coarse_entities)), dtype=np.float64)
    details: Dict[Tuple[int, int], Dict[str, float]] = {}
    for first, source in enumerate(base_entities):
        source_mask = base_masks[source["id"]]
        for second, target in enumerate(coarse_entities):
            target_mask = lifted_mask(coarse_masks[target["id"]], shape)
            intersection = np.logical_and(source_mask, target_mask).sum(); union = np.logical_or(source_mask, target_mask).sum()
            overlap = float(intersection / union) if union else 0.0
            target_center = [value * factor for value in target["geometry"]["centroid"]]
            centroid = math.hypot(source["geometry"]["centroid"][0] - target_center[0], source["geometry"]["centroid"][1] - target_center[1]) / max(diagonal, 1.0)
            color = min(float(np.linalg.norm(np.subtract(source["appearance"]["meanLab"], target["appearance"]["meanLab"]))) / 2.0, 1.0)
            area = abs(math.log((source["geometry"]["area"] + 1e-9) / max(target_mask.sum(), 1)))
            cost = 0.45 * (1.0 - overlap) + 0.20 * centroid + 0.20 * color + 0.15 * min(area, 1.0)
            costs[first, second] = cost; details[(first, second)] = {"iou": overlap, "centroidDistance": centroid, "appearanceDifference": color, "logAreaDifference": area, "cost": cost}
    rows, columns = linear_sum_assignment(costs)
    links: List[Dict[str, Any]] = []
    for row, column in zip(rows, columns):
        detail = details[(int(row), int(column))]
        if detail["cost"] > 0.72:
            continue
        source, target = base_entities[int(row)], coarse_entities[int(column)]
        source["crossScaleMatchId"] = target["id"]
        links.append({"sourceId": source["id"], "targetId": target["id"], "relationshipType": ["cross_scale_correspondence"], "confidence": rounded(1.0 - detail["cost"], 8), **{key: rounded(value, 8) for key, value in detail.items()}})
    return links

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


def overlap_scales(base_entities: List[Dict[str, Any]], base_masks: Dict[str, np.ndarray], coarse_entities: List[Dict[str, Any]], coarse_masks: Dict[str, np.ndarray], factor: int, shape: Tuple[int, int], minimum_coverage: float) -> List[Dict[str, Any]]:
    """Emit all meaningful fine-to-coarse mask overlaps without implying containment."""
    links: List[Dict[str, Any]] = []
    for source in base_entities:
        source_mask = base_masks[source["id"]]
        source_area = max(int(source_mask.sum()), 1)
        for target in coarse_entities:
            target_mask = lifted_mask(coarse_masks[target["id"]], shape)
            intersection = int(np.logical_and(source_mask, target_mask).sum())
            if not intersection:
                continue
            coverage = intersection / source_area
            union = int(np.logical_or(source_mask, target_mask).sum())
            overlap_iou = intersection / max(union, 1)
            if coverage < minimum_coverage:
                continue
            source.setdefault("crossScaleOverlapIds", []).append(target["id"])
            links.append({
                "sourceId": source["id"], "targetId": target["id"], "relationshipType": ["cross_scale_overlap"], "primaryType": "cross_scale_overlap", "entityLevel": source["level"],
                "confidence": rounded(coverage, 8), "fineCoverage": rounded(coverage, 8), "overlapIoU": rounded(overlap_iou, 8), "resolutionFactor": factor,
                "semantics": "fine_to_coarse_overlap_not_hierarchy_containment",
            })
    return links


def normalized_overlap_matrix(overlap_links: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Summarize significant lifted-mask overlaps as sparse, fine-row-normalized matrices."""
    matrices: List[Dict[str, Any]] = []
    for factor in sorted({int(link["resolutionFactor"]) for link in overlap_links}):
        rows: Dict[str, List[Dict[str, Any]]] = {}
        for link in overlap_links:
            if int(link["resolutionFactor"]) != factor:
                continue
            rows.setdefault(str(link["sourceId"]), []).append({"targetId": link["targetId"], "fineCoverage": link["fineCoverage"], "overlapIoU": link["overlapIoU"]})
        serialized_rows: List[Dict[str, Any]] = []
        for source_id in sorted(rows):
            entries = sorted(rows[source_id], key=lambda item: str(item["targetId"]))
            coverage = float(sum(float(item["fineCoverage"]) for item in entries))
            serialized_rows.append({"sourceId": source_id, "coverageSum": rounded(coverage, 8), "uncoveredFraction": rounded(max(0.0, 1.0 - coverage), 8), "entries": entries})
        matrices.append({"resolutionFactor": factor, "rowCount": len(serialized_rows), "columnCount": len({item["targetId"] for row in serialized_rows for item in row["entries"]}), "rows": serialized_rows})
    return {"schema": "NormalizedFineToCoarseOverlapMatrix@0.7", "normalization": "each row stores lifted fine-mask coverage for links that meet crossScaleOverlapThreshold; omitted entries are zero", "matrices": matrices}

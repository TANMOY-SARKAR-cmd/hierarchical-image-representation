"""Connectivity-constrained graph-driven recursive agglomeration."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

from geometry import make_entity, stable_id
from graph import build_relationships


def connected(mask: np.ndarray) -> bool:
    return int(cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)[0]) == 2


def adjacency_from_masks(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray]) -> set[Tuple[str, str]]:
    links: set[Tuple[str, str]] = set()
    for index, source in enumerate(entities):
        source_mask = masks[source["id"]]
        dilated = cv2.dilate(source_mask.astype(np.uint8), np.ones((3, 3), dtype=np.uint8)).astype(bool)
        for target in entities[index + 1:]:
            if np.logical_and(dilated, masks[target["id"]]).any():
                links.add(tuple(sorted((source["id"], target["id"]))))
    return links


def boundary_edge_strength(first: np.ndarray, second: np.ndarray, edge_field: np.ndarray) -> float:
    horizontal = (first[:, :-1] & second[:, 1:]) | (second[:, :-1] & first[:, 1:])
    vertical = (first[:-1, :] & second[1:, :]) | (second[:-1, :] & first[1:, :])
    values = np.concatenate((edge_field[:, :-1][horizontal], edge_field[:, 1:][horizontal], edge_field[:-1, :][vertical], edge_field[1:, :][vertical]))
    return float(values.mean()) if values.size else 0.0


def graph_group_level(children: List[Dict[str, Any]], masks: Dict[str, np.ndarray], rgb: np.ndarray, fields: Dict[str, np.ndarray], entity_type: str, level: int, config: Dict[str, Any], threshold_multiplier: float) -> List[Dict[str, Any]]:
    if not children:
        return []
    adjacency = adjacency_from_masks(children, masks)
    edges = build_relationships(children, masks, adjacency, rgb.shape[:2], config)
    used: set[str] = set(); grouped: List[Tuple[List[Dict[str, Any]], Dict[str, Any] | None]] = []
    threshold = float(config["mergeThreshold"]) * threshold_multiplier
    max_area = rgb.shape[0] * rgb.shape[1] * float(config["maxEntityAreaFraction"])
    barrier_threshold = float(config["edgeBarrierThreshold"])
    for edge in sorted(edges, key=lambda item: (-item["mergeAffinity"], item["sourceId"], item["targetId"])):
        source_id, target_id = edge["sourceId"], edge["targetId"]
        if source_id in used or target_id in used or not edge["adjacent"] or edge["mergeAffinity"] < threshold:
            continue
        pair = [next(entity for entity in children if entity["id"] == source_id), next(entity for entity in children if entity["id"] == target_id)]
        contact_edge_strength = boundary_edge_strength(masks[source_id], masks[target_id], fields["edge_strength"])
        edge["boundaryEdgeStrength"] = contact_edge_strength
        if contact_edge_strength > barrier_threshold:
            continue
        merged_mask = masks[source_id] | masks[target_id]
        if merged_mask.sum() > max_area or not connected(merged_mask):
            continue
        used.update((source_id, target_id)); grouped.append((pair, {"mergeAffinity": edge["mergeAffinity"], "boundaryEdgeStrength": contact_edge_strength, "edgeBarrierThreshold": barrier_threshold}))
    grouped.extend(([child], None) for child in children if child["id"] not in used)
    parents: List[Dict[str, Any]] = []
    prefix = entity_type.replace("_", "")
    for group, merge_evidence in grouped:
        child_ids = [child["id"] for child in group]
        parent_id = stable_id(prefix, child_ids, level)
        mask = np.zeros_like(next(iter(masks.values())), dtype=bool)
        for child in group:
            mask |= masks[child["id"]]
        lineage = {"operation": "merge" if len(group) > 1 else "carry", "parents": child_ids}
        if merge_evidence:
            lineage["mergeEvidence"] = merge_evidence
        parent = make_entity(parent_id, entity_type, level, 1, mask, rgb, fields, child_ids, lineage)
        for child in group:
            child["parentId"] = parent_id
        masks[parent_id] = mask
        parents.append(parent)
    return parents

"""Deterministic connectivity-constrained iterative graph agglomeration."""

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
    threshold = float(config["mergeThreshold"]) * threshold_multiplier
    max_area = rgb.shape[0] * rgb.shape[1] * float(config["maxEntityAreaFraction"])
    barrier_threshold = float(config["edgeBarrierThreshold"])
    prefix = entity_type.replace("_", "")
    active: Dict[str, Dict[str, Any]] = {
        child["id"]: {"entity": child, "mask": masks[child["id"]], "members": [child], "events": []}
        for child in children
    }
    iteration = 0
    max_iterations = int(config.get("maxAgglomerationIterations", 2048))
    while len(active) > 1 and iteration < max_iterations:
        active_entities = [active[key]["entity"] for key in sorted(active)]
        active_masks = {key: active[key]["mask"] for key in active}
        adjacency = adjacency_from_masks(active_entities, active_masks)
        edges = build_relationships(active_entities, active_masks, adjacency, rgb.shape[:2], config)
        accepted: Tuple[Dict[str, Any], np.ndarray, float] | None = None
        for edge in sorted(edges, key=lambda item: (-item["mergeAffinity"], item["sourceId"], item["targetId"])):
            source_id, target_id = edge["sourceId"], edge["targetId"]
            if not edge["adjacent"] or edge["mergeAffinity"] < threshold:
                continue
            merged_mask = active_masks[source_id] | active_masks[target_id]
            contact_edge_strength = boundary_edge_strength(active_masks[source_id], active_masks[target_id], fields["edge_strength"])
            if contact_edge_strength > barrier_threshold or merged_mask.sum() > max_area or not connected(merged_mask):
                continue
            accepted = (edge, merged_mask, contact_edge_strength)
            break
        if accepted is None:
            break
        edge, merged_mask, contact_edge_strength = accepted
        source_id, target_id = edge["sourceId"], edge["targetId"]
        source, target = active.pop(source_id), active.pop(target_id)
        members = [*source["members"], *target["members"]]
        member_ids = [member["id"] for member in members]
        working_id = stable_id(f"{prefix}working", member_ids, level)
        working_entity = make_entity(working_id, entity_type, level, 1, merged_mask, rgb, fields, member_ids, {"operation": "working_merge", "parents": member_ids})
        event = {"iteration": iteration + 1, "sourceId": source_id, "targetId": target_id, "mergeAffinity": edge["mergeAffinity"], "boundaryEdgeStrength": contact_edge_strength, "edgeBarrierThreshold": barrier_threshold}
        active[working_id] = {"entity": working_entity, "mask": merged_mask, "members": members, "events": [*source["events"], *target["events"], event]}
        iteration += 1
    parents: List[Dict[str, Any]] = []
    for node in (active[key] for key in sorted(active)):
        group = node["members"]
        child_ids = [child["id"] for child in group]
        parent_id = stable_id(prefix, child_ids, level)
        mask = node["mask"]
        events = node["events"]
        lineage = {"operation": "iterative_merge" if events else "carry", "parents": child_ids, "iterationCount": len(events), "mergeSequence": events}
        if events:
            lineage["mergeEvidence"] = events[-1]
        parent = make_entity(parent_id, entity_type, level, 1, mask, rgb, fields, child_ids, lineage)
        for child in group:
            child["parentId"] = parent_id
        masks[parent_id] = mask
        parents.append(parent)
    return parents

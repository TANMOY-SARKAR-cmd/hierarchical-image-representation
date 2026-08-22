"""Deterministic global merge-tree construction and derived hierarchy cuts."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np

from geometry import aggregate_sufficient_statistics, make_entity, mean_variance, stable_id
from graph import build_relationships


def connected(mask: np.ndarray) -> bool:
    return int(cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)[0]) == 2


def adjacency_from_masks(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray]) -> set[Tuple[str, str]]:
    links: set[Tuple[str, str]] = set()
    for index, source in enumerate(entities):
        first = masks[source["id"]]
        for target in entities[index + 1:]:
            second = masks[target["id"]]
            touches = (
                np.logical_and(first[:, 1:], second[:, :-1]).any()
                or np.logical_and(second[:, 1:], first[:, :-1]).any()
                or np.logical_and(first[1:, :], second[:-1, :]).any()
                or np.logical_and(second[1:, :], first[:-1, :]).any()
            )
            if touches:
                links.add(tuple(sorted((source["id"], target["id"]))))
    return links


def boundary_edge_strength(first: np.ndarray, second: np.ndarray, edge_field: np.ndarray) -> float:
    horizontal = (first[:, 1:] & second[:, :-1]) | (second[:, 1:] & first[:, :-1])
    vertical = (first[1:, :] & second[:-1, :]) | (second[1:, :] & first[:-1, :])
    values = np.concatenate((edge_field[:, 1:][horizontal], edge_field[:, :-1][horizontal], edge_field[1:, :][vertical], edge_field[:-1, :][vertical]))
    return float(values.mean()) if values.size else 0.0


def _lab_variance_energy(entity: Dict[str, Any]) -> float:
    stats = entity["statistics"]["sufficient"]
    return float(sum(mean_variance(stats, name)[1] for name in ("lab_l", "lab_a", "lab_b")) / (100.0 ** 2 + 128.0 ** 2 + 128.0 ** 2))


def merge_energy(source: Dict[str, Any], target: Dict[str, Any], union: Dict[str, Any], contact_boundary: float, image_pixels: int, config: Dict[str, Any]) -> Dict[str, float]:
    """Local deterministic partition-energy approximation for one candidate union."""
    source_area, target_area = source["geometry"]["area"], target["geometry"]["area"]
    total_area = max(source_area + target_area, 1)
    current_distortion = (source_area * _lab_variance_energy(source) + target_area * _lab_variance_energy(target)) / total_area
    delta_distortion = _lab_variance_energy(union) - current_distortion
    delta_rate = -1.0 / max(image_pixels, 1)
    previous_compactness = (source_area * source["geometry"]["compactness"] + target_area * target["geometry"]["compactness"]) / total_area
    delta_shape = max(0.0, previous_compactness - union["geometry"]["compactness"])
    previous_complexity = (source_area * source["statistics"]["complexity"] + target_area * target["statistics"]["complexity"]) / total_area
    delta_complexity = max(0.0, union["statistics"]["complexity"] - previous_complexity)
    weights = config["mergeEnergyWeights"]
    value = (
        weights["distortion"] * delta_distortion
        + weights["rate"] * delta_rate
        + weights["boundary"] * contact_boundary
        + weights["shape"] * delta_shape
        + weights["complexity"] * delta_complexity
    )
    return {
        "deltaJ": float(value), "deltaDistortion": float(delta_distortion), "deltaRate": float(delta_rate),
        "deltaBoundary": float(contact_boundary), "deltaShape": float(delta_shape), "deltaComplexity": float(delta_complexity),
    }


def build_global_merge_tree(leaves: List[Dict[str, Any]], masks: Dict[str, np.ndarray], rgb: np.ndarray, fields: Dict[str, np.ndarray], config: Dict[str, Any], initial_adjacency: Optional[set[Tuple[str, str]]] = None) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Create persistent merge nodes until no valid candidate improves the local objective."""
    active: Dict[str, Dict[str, Any]] = {leaf["id"]: leaf for leaf in leaves}
    nodes: List[Dict[str, Any]] = []
    evidence: List[Dict[str, Any]] = []
    neighbours: Optional[Dict[str, set[str]]] = None
    if initial_adjacency is not None:
        neighbours = {entity_id: set() for entity_id in active}
        for source_id, target_id in initial_adjacency:
            if source_id in neighbours and target_id in neighbours:
                neighbours[source_id].add(target_id); neighbours[target_id].add(source_id)
    max_area = rgb.shape[0] * rgb.shape[1] * float(config["maxEntityAreaFraction"])
    threshold = float(config["mergeEnergyThreshold"])
    max_iterations = int(config["maxAgglomerationIterations"])
    iteration = 0
    while len(active) > 1 and iteration < max_iterations:
        entities = [active[key] for key in sorted(active)]
        active_masks = {key: masks[key] for key in active}
        adjacency = (
            {tuple(sorted((source_id, target_id))) for source_id, targets in neighbours.items() if source_id in active for target_id in targets if target_id in active and source_id != target_id}
            if neighbours is not None else adjacency_from_masks(entities, active_masks)
        )
        relationships = build_relationships(entities, active_masks, adjacency, rgb.shape[:2], config)
        candidates: List[Tuple[float, str, str, np.ndarray, Dict[str, Any], Dict[str, float]]] = []
        for relationship in relationships:
            source_id, target_id = relationship["sourceId"], relationship["targetId"]
            if not relationship["adjacent"]:
                continue
            merged_mask = active_masks[source_id] | active_masks[target_id]
            contact_boundary = boundary_edge_strength(active_masks[source_id], active_masks[target_id], fields["edge_strength"])
            rejection: str | None = None
            if merged_mask.sum() > max_area:
                rejection = "max_area"
            elif contact_boundary > float(config["edgeBarrierThreshold"]):
                rejection = "edge_barrier"
            elif not connected(merged_mask):
                rejection = "not_4_connected"
            if rejection:
                evidence.append({"iteration": iteration + 1, "sourceId": source_id, "targetId": target_id, "accepted": False, "reason": rejection})
                continue
            source, target = active[source_id], active[target_id]
            child_ids = [source_id, target_id]
            union_stats = aggregate_sufficient_statistics([source, target])
            provisional = make_entity("provisional", "merge_node", max(source["level"], target["level"]) + 1, 1, merged_mask, rgb, fields, child_ids, sufficient_override=union_stats)
            terms = merge_energy(source, target, provisional, contact_boundary, rgb.shape[0] * rgb.shape[1], config)
            candidates.append((terms["deltaJ"], source_id, target_id, merged_mask, relationship, terms))
        if not candidates:
            break
        delta_j, source_id, target_id, merged_mask, relationship, terms = min(candidates, key=lambda item: (item[0], item[1], item[2]))
        if delta_j > threshold:
            evidence.append({"iteration": iteration + 1, "accepted": False, "reason": "energy_threshold", "bestDeltaJ": delta_j, "threshold": threshold})
            break
        source, target = active.pop(source_id), active.pop(target_id)
        child_ids = [source_id, target_id]
        level = max(source["level"], target["level"]) + 1
        node_id = stable_id("merge", child_ids, level)
        event = {"iteration": iteration + 1, "sourceId": source_id, "targetId": target_id, "accepted": True, "relationship": relationship, "energy": terms, "edgeBarrierThreshold": float(config["edgeBarrierThreshold"])}
        node = make_entity(node_id, "merge_node", level, 1, merged_mask, rgb, fields, child_ids, {"operation": "energy_merge", "parents": child_ids, "mergeEvidence": event, "mergeSequence": [event]}, aggregate_sufficient_statistics([source, target]))
        node["treeLeafCount"] = int(source.get("treeLeafCount", 1) + target.get("treeLeafCount", 1))
        source["parentId"] = node_id; target["parentId"] = node_id
        masks[node_id] = merged_mask; active[node_id] = node; nodes.append(node); evidence.append(event); iteration += 1
        if neighbours is not None:
            merged_neighbours = (neighbours.pop(source_id, set()) | neighbours.pop(target_id, set())) - {source_id, target_id}
            neighbours[node_id] = set()
            for neighbour_id in sorted(merged_neighbours):
                if neighbour_id not in active:
                    continue
                neighbours[neighbour_id].discard(source_id); neighbours[neighbour_id].discard(target_id); neighbours[neighbour_id].add(node_id)
                neighbours[node_id].add(neighbour_id)
    return nodes, [active[key] for key in sorted(active)], evidence


def derive_tree_cut(roots: Iterable[Dict[str, Any]], lookup: Dict[str, Dict[str, Any]], target_node_count: int) -> List[Dict[str, Any]]:
    """Expand the largest available merge nodes until a deterministic target cut is reached."""
    cut = list(roots)
    while len(cut) < target_node_count:
        expandable = [node for node in cut if node.get("children")]
        if not expandable:
            break
        node = min(expandable, key=lambda item: (-int(item.get("treeLeafCount", 1)), item["id"]))
        cut.remove(node)
        cut.extend(lookup[child_id] for child_id in node["children"])
    return sorted(cut, key=lambda item: item["id"])


def graph_group_level(children: List[Dict[str, Any]], masks: Dict[str, np.ndarray], rgb: np.ndarray, fields: Dict[str, np.ndarray], entity_type: str, level: int, config: Dict[str, Any], threshold_multiplier: float = 1.0) -> List[Dict[str, Any]]:
    """Compatibility wrapper retained for historical direct tests; v0.7 engine uses the global tree."""
    nodes, roots, _ = build_global_merge_tree(children, masks, rgb, fields, config)
    lookup = {item["id"]: item for item in [*children, *nodes]}
    selected = derive_tree_cut(roots, lookup, max(1, len(children) // 2))
    for item in selected:
        item["type"] = entity_type
        item["level"] = level
    return selected

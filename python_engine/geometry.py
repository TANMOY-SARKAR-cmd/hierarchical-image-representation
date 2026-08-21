"""Canonical mask geometry, sufficient statistics, and structured entity vectors."""

from __future__ import annotations

import hashlib
import math
from typing import Any, Dict, Iterable, List, Tuple

import cv2
import numpy as np
from skimage.measure import perimeter as mask_perimeter

EPSILON = 1e-9


def rounded(value: float, digits: int = 8) -> float:
    return round(float(value), digits)


def stable_id(prefix: str, children: Iterable[str], level: int) -> str:
    digest = hashlib.sha1(("|".join(sorted(children)) + f"|{level}").encode("utf-8")).hexdigest()[:10]
    return f"{prefix}-{digest}"


def canonical_geometry(mask: np.ndarray) -> Dict[str, Any]:
    ys, xs = np.where(mask)
    if not len(xs):
        raise ValueError("Cannot create geometry for an empty mask.")
    min_x, max_x, min_y, max_y = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    area = int(mask.sum())
    perimeter = rounded(mask_perimeter(mask, neighborhood=4), 6)
    if len(xs) < 2:
        orientation = 0.0
    else:
        values, vectors = np.linalg.eigh(np.cov(np.vstack((xs, ys))))
        direction = vectors[:, int(np.argmax(values))]
        orientation = rounded(math.degrees(math.atan2(direction[1], direction[0])) % 180.0, 6)
    compactness = rounded((4.0 * math.pi * area) / max(perimeter * perimeter, EPSILON), 8)
    return {"boundingBox": [min_x, min_y, max_x, max_y], "centroid": [rounded(xs.mean(), 6), rounded(ys.mean(), 6)], "area": area, "perimeter": perimeter, "orientation": orientation, "compactness": compactness}


def hu_descriptor(mask: np.ndarray) -> List[float]:
    moments = cv2.moments(mask.astype(np.uint8))
    hu = cv2.HuMoments(moments).flatten()
    return [rounded(-math.copysign(math.log10(max(abs(value), 1e-30)), value), 8) for value in hu]


def sufficient_statistics(mask: np.ndarray, rgb: np.ndarray, fields: Dict[str, np.ndarray]) -> Dict[str, Any]:
    names = ["red", "green", "blue", "lightness", "lab_l", "lab_a", "lab_b", "gradient_magnitude", "edge_strength", "local_variance", "local_entropy", "complexity"]
    stats: Dict[str, Any] = {"schema": "SufficientStatistics@0.7", "count": int(mask.sum()), "sum": {}, "sumSquares": {}}
    for name in names:
        values = fields[name][mask].astype(np.float64)
        stats["sum"][name] = rounded(values.sum(), 10)
        stats["sumSquares"][name] = rounded(np.square(values).sum(), 10)
    return stats


def aggregate_sufficient_statistics(children: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Exactly aggregate scalar sufficient statistics without rereading descendant pixels."""
    child_stats = [child["statistics"]["sufficient"] for child in children]
    if not child_stats:
        raise ValueError("Cannot aggregate an empty child set.")
    names = sorted(child_stats[0]["sum"])
    if any(sorted(stats["sum"]) != names for stats in child_stats):
        raise ValueError("Child sufficient-statistics fields are inconsistent.")
    return {
        "schema": "SufficientStatistics@0.7",
        "count": int(sum(int(stats["count"]) for stats in child_stats)),
        "sum": {name: rounded(sum(float(stats["sum"][name]) for stats in child_stats), 10) for name in names},
        "sumSquares": {name: rounded(sum(float(stats["sumSquares"][name]) for stats in child_stats), 10) for name in names},
    }


def mean_variance(stats: Dict[str, Any], name: str) -> Tuple[float, float]:
    count = max(int(stats["count"]), 1)
    mean = float(stats["sum"][name]) / count
    variance = max(float(stats["sumSquares"][name]) / count - mean * mean, 0.0)
    return mean, variance


def make_entity(entity_id: str, entity_type: str, level: int, resolution_factor: int, mask: np.ndarray, rgb: np.ndarray, fields: Dict[str, np.ndarray], children: Iterable[str] | None = None, lineage: Dict[str, Any] | None = None, sufficient_override: Dict[str, Any] | None = None) -> Dict[str, Any]:
    geometry = canonical_geometry(mask)
    statistics = sufficient_override or sufficient_statistics(mask, rgb, fields)
    if int(statistics["count"]) != geometry["area"]:
        raise ValueError("Sufficient-statistics count must equal canonical mask area.")
    mean_r, var_r = mean_variance(statistics, "red"); mean_g, var_g = mean_variance(statistics, "green"); mean_b, var_b = mean_variance(statistics, "blue")
    brightness, brightness_var = mean_variance(statistics, "lightness")
    lab_l, lab_l_var = mean_variance(statistics, "lab_l"); lab_a, _ = mean_variance(statistics, "lab_a"); lab_b, _ = mean_variance(statistics, "lab_b")
    gradient, gradient_variance = mean_variance(statistics, "gradient_magnitude")
    edge_density, _ = mean_variance(statistics, "edge_strength"); texture, _ = mean_variance(statistics, "local_variance"); entropy, _ = mean_variance(statistics, "local_entropy"); complexity, _ = mean_variance(statistics, "complexity")
    box = geometry["boundingBox"]
    width, height = box[2] - box[0] + 1, box[3] - box[1] + 1
    shape = {"huMoments": hu_descriptor(mask)}
    structured = {
        "geometry": {"centroidX": geometry["centroid"][0], "centroidY": geometry["centroid"][1], "width": width, "height": height, "area": geometry["area"], "perimeter": geometry["perimeter"], "compactness": geometry["compactness"], "orientation": geometry["orientation"], "localCoordinates": {"system": "bbox_normalized_minus_one_to_one", "origin": [box[0], box[1]], "extent": [width, height]}},
        "appearance": {"meanRGB": [mean_r, mean_g, mean_b], "meanLab": [lab_l, lab_a, lab_b], "varianceRGB": [var_r, var_g, var_b], "varianceLightness": lab_l_var},
        "structure": {"meanGradient": gradient, "gradientVariance": gradient_variance, "edgeDensity": edge_density, "texture": texture, "entropy": entropy, "complexity": complexity},
        "shape": shape,
    }
    values = [geometry["centroid"][0], geometry["centroid"][1], width, height, geometry["area"], geometry["perimeter"], geometry["compactness"], geometry["orientation"], mean_r, mean_g, mean_b, lab_l, lab_a, lab_b, var_r, var_g, var_b, lab_l_var, gradient, gradient_variance, edge_density, texture, entropy, complexity, *shape["huMoments"]]
    child_ids = list(children or [])
    return {
        "id": entity_id, "type": entity_type, "level": level, "resolutionFactor": resolution_factor, "scaleFactor": resolution_factor,
        "geometry": geometry,
        "appearance": {"meanRGB": [rounded(value * 255.0, 4) for value in (mean_r, mean_g, mean_b)], "meanLab": [rounded(value, 6) for value in (lab_l, lab_a, lab_b)], "brightness": rounded(brightness, 8), "varianceRGB": [rounded(value, 8) for value in (var_r, var_g, var_b)], "brightnessVariance": rounded(brightness_var, 8), "meanGradient": rounded(gradient, 8), "gradientVariance": rounded(gradient_variance, 8), "edgeDensity": rounded(edge_density, 8), "textureMeasure": rounded(texture, 8), "entropy": rounded(entropy, 8)},
        "statistics": {"memberPixelCount": geometry["area"], "sufficient": statistics, "complexity": rounded(complexity, 8)},
        "shape": shape,
        "vector": {"schema": "EntityVector@0.7", "dimension": len(values), "values": [rounded(value, 8) for value in values], "structured": structured, "provenance": "canonical_mask_union", "aggregation": "child_sufficient_statistics_and_canonical_mask_geometry" if sufficient_override else "pixel_sufficient_statistics_and_canonical_mask_geometry"},
        "children": child_ids, "parentId": None, "crossScaleMatchId": None,
        "lineage": lineage or {"operation": "segment", "parents": []},
    }

"""Progressive constant-model reconstruction and research artifact helpers."""

from __future__ import annotations

import gzip
import math
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from PIL import Image
from skimage.measure import find_contours
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

from features import unit_normalize
from geometry import rounded


def metrics_for(original: np.ndarray, reconstructed: np.ndarray) -> Dict[str, float]:
    mse = float(np.mean((original.astype(np.float32) - reconstructed.astype(np.float32)) ** 2))
    smallest = min(original.shape[:2])
    window = max(3, min(7, smallest if smallest % 2 else smallest - 1))
    ssim = 1.0 if smallest < 3 else float(structural_similarity(original, reconstructed, channel_axis=2, data_range=255, win_size=window))
    psnr = 99.0 if mse <= 1e-9 else min(float(peak_signal_noise_ratio(original, reconstructed, data_range=255)), 99.0)
    return {"mse": rounded(mse, 8), "psnr": rounded(psnr, 6), "ssim": rounded(ssim, 8)}


def reconstruct_entities(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], shape: Tuple[int, int, int]) -> np.ndarray:
    output = np.zeros(shape, dtype=np.uint8)
    for entity in entities:
        output[masks[entity["id"]]] = np.rint(np.array(entity["appearance"]["meanRGB"])).astype(np.uint8)
    return output


def write_overlay(values: np.ndarray, output_path: Path, colormap: int = cv2.COLORMAP_TURBO) -> None:
    cv2.imwrite(str(output_path), cv2.applyColorMap((unit_normalize(values) * 255).astype(np.uint8), colormap))


ERROR_HEATMAP_REFERENCE_MEAN_ABSOLUTE_RGB_DELTA = 32.0
ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA = 1.0


def absolute_rgb_channel_sum(original: np.ndarray, reconstructed: np.ndarray) -> np.ndarray:
    return np.abs(original.astype(np.int16) - reconstructed.astype(np.int16)).sum(axis=2).astype(np.uint16)


def mean_absolute_rgb_delta(original: np.ndarray, reconstructed: np.ndarray) -> np.ndarray:
    return absolute_rgb_channel_sum(original, reconstructed).astype(np.float32) / 3.0


def write_error_evidence_sidecar(values: np.ndarray, output_path: Path) -> Dict[str, int]:
    if values.ndim != 2 or values.dtype != np.uint16:
        raise ValueError("error evidence must be a two-dimensional uint16 absolute RGB channel-sum array")
    height, width = values.shape
    header = np.array([width, height], dtype="<u4").tobytes()
    output_path.write_bytes(gzip.compress(header + values.astype("<u2", copy=False).tobytes(order="C"), compresslevel=6))
    return {"width": int(width), "height": int(height), "bytesPerValue": 2}


def calibrated_error_heatmap_rgba(values: np.ndarray, threshold_delta: float = ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA, reference_delta: float = ERROR_HEATMAP_REFERENCE_MEAN_ABSOLUTE_RGB_DELTA) -> np.ndarray:
    if values.ndim != 2:
        raise ValueError("error heatmap values must be two-dimensional")
    if reference_delta <= 0 or threshold_delta < 0 or threshold_delta > reference_delta:
        raise ValueError("threshold_delta must be between zero and the positive reference_delta")
    magnitude = np.clip(values.astype(np.float32) / reference_delta, 0.0, 1.0)
    color = cv2.applyColorMap(np.rint(magnitude * 255.0).astype(np.uint8), cv2.COLORMAP_INFERNO)
    visible = np.clip((values.astype(np.float32) - threshold_delta) / max(reference_delta - threshold_delta, 1e-9), 0.0, 1.0)
    alpha = np.rint((visible ** 0.75) * 255.0).astype(np.uint8)
    return np.dstack((color, alpha))


def write_calibrated_error_heatmap(original: np.ndarray, reconstructed: np.ndarray, output_path: Path, reference_delta: float = ERROR_HEATMAP_REFERENCE_MEAN_ABSOLUTE_RGB_DELTA) -> Dict[str, float]:
    """Write an RGBA error visualization whose color and alpha use fixed RGB-difference calibration."""
    if reference_delta <= 0:
        raise ValueError("reference_delta must be positive")
    error = mean_absolute_rgb_delta(original, reconstructed)
    cv2.imwrite(str(output_path), calibrated_error_heatmap_rgba(error, ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA, reference_delta))
    return {
        "meanAbsoluteRgbDelta": rounded(float(error.astype(np.float32).mean()), 8),
        "maxAbsoluteRgbDelta": rounded(float(error.max()), 8),
        "referenceMeanAbsoluteRgbDelta": rounded(reference_delta, 8),
        "transparentBelowMeanAbsoluteRgbDelta": rounded(ERROR_HEATMAP_TRANSPARENT_BELOW_MEAN_ABSOLUTE_RGB_DELTA, 8),
    }


def create_svg(labels: np.ndarray, rgb: np.ndarray, output_path: Path) -> None:
    height, width = labels.shape
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Micro-region boundaries">']
    for label in range(1, int(labels.max()) + 1):
        mask = labels == label; contours = find_contours(mask.astype(float), 0.5)
        if not contours:
            continue
        contour = max(contours, key=len)[::max(1, len(max(contours, key=len)) // 96)]
        color = tuple(int(round(value)) for value in rgb[mask].mean(axis=0))
        parts.append(f'<polygon id="micro-region-{label}" points="{" ".join(f"{point[1]:.2f},{point[0]:.2f}" for point in contour)}" fill="rgb{color}" stroke="#09111f" stroke-width="0.7"/>')
    parts.append("</svg>"); output_path.write_text("\n".join(parts), encoding="utf-8")


def write_relationship_overlay(rgb: np.ndarray, entities: List[Dict[str, Any]], relationships: List[Dict[str, Any]], output_path: Path, distance_coloring: bool = False) -> None:
    canvas = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR).copy(); lookup = {entity["id"]: entity for entity in entities}
    for relationship in relationships:
        source, target = lookup.get(relationship["sourceId"]), lookup.get(relationship["targetId"])
        if not source or not target:
            continue
        start = tuple(int(round(value)) for value in source["geometry"]["centroid"]); end = tuple(int(round(value)) for value in target["geometry"]["centroid"])
        color = (0, int(255 * (1 - relationship["normalizedDistance"])), int(255 * relationship["normalizedDistance"])) if distance_coloring else ((70, 230, 70) if relationship.get("adjacent") else (230, 170, 40))
        cv2.line(canvas, start, end, color, 1, cv2.LINE_AA)
    cv2.imwrite(str(output_path), canvas)

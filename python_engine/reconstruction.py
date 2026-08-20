"""Progressive constant-model reconstruction and research artifact helpers."""

from __future__ import annotations

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

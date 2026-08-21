"""Dense pixel fields with explicit physical/statistical units and normalized analysis channels."""

from __future__ import annotations

from typing import Any, Dict, Tuple

import cv2
import numpy as np
from scipy.ndimage import uniform_filter

PIXEL_VECTOR_FIELDS = [
    "geometry.x_normalized", "geometry.y_normalized",
    "appearance.red", "appearance.green", "appearance.blue", "appearance.lightness", "appearance.saturation", "appearance.hue",
    "appearance.lab_l", "appearance.lab_a", "appearance.lab_b",
    "local_structure.gradient_x", "local_structure.gradient_y", "local_structure.gradient_magnitude", "local_structure.gradient_orientation",
    "local_structure.edge_strength", "local_structure.local_variance", "local_structure.local_entropy", "local_structure.complexity",
]


def robust_normalize(values: np.ndarray, epsilon: float = 1e-6) -> np.ndarray:
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    scaled = (values.astype(np.float32) - median) / max(1.4826 * mad, epsilon)
    return (np.clip(scaled, -3.0, 3.0) / 3.0).astype(np.float32)


def unit_normalize(values: np.ndarray, epsilon: float = 1e-9) -> np.ndarray:
    low, high = float(values.min()), float(values.max())
    if high - low <= epsilon:
        return np.zeros_like(values, dtype=np.float32)
    return ((values - low) / (high - low)).astype(np.float32)


def local_entropy(brightness: np.ndarray, window: int = 5) -> np.ndarray:
    """A deterministic local entropy approximation over quantized luminance."""
    quantized = np.clip((brightness * 15).astype(np.int32), 0, 15)
    entropy = np.zeros_like(brightness, dtype=np.float32)
    for value in range(16):
        probability = uniform_filter((quantized == value).astype(np.float32), size=window, mode="reflect")
        valid = probability > 1e-7
        entropy[valid] -= probability[valid] * np.log2(probability[valid])
    return (entropy / 4.0).astype(np.float32)


def extract_features(rgb: np.ndarray, config: Dict[str, Any]) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    height, width, _ = rgb.shape
    rgb_unit = rgb.astype(np.float32) / 255.0
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    gradient_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient_magnitude = np.hypot(gradient_x, gradient_y).astype(np.float32)
    gradient_orientation = np.arctan2(gradient_y, gradient_x).astype(np.float32)
    gradient_reference = max(float(np.percentile(gradient_magnitude, float(config.get("boundaryGradientPercentile", 99.0)))), 1e-6)
    edge_strength = np.clip(gradient_magnitude / gradient_reference, 0.0, 1.0).astype(np.float32)
    local_mean = uniform_filter(gray, size=5, mode="reflect")
    local_variance = np.maximum(uniform_filter(gray * gray, size=5, mode="reflect") - local_mean * local_mean, 0).astype(np.float32)
    entropy = local_entropy(gray)
    weights = config["featureWeights"]
    complexity = (
        weights["gradient"] * unit_normalize(robust_normalize(gradient_magnitude))
        + weights["variance"] * unit_normalize(robust_normalize(local_variance))
        + weights["edge"] * edge_strength
        + weights["texture"] * entropy
    ).astype(np.float32)
    yy, xx = np.mgrid[0:height, 0:width]
    fields = {
        "x_normalized": (xx / max(width - 1, 1)).astype(np.float32), "y_normalized": (yy / max(height - 1, 1)).astype(np.float32),
        "red": rgb_unit[:, :, 0], "green": rgb_unit[:, :, 1], "blue": rgb_unit[:, :, 2], "lightness": gray,
        "saturation": hsv[:, :, 1] / 255.0, "hue": hsv[:, :, 0] / 179.0,
        "lab_l": lab[:, :, 0] * (100.0 / 255.0), "lab_a": lab[:, :, 1] - 128.0, "lab_b": lab[:, :, 2] - 128.0,
        "gradient_x": robust_normalize(gradient_x), "gradient_y": robust_normalize(gradient_y), "gradient_magnitude": np.clip(gradient_magnitude / gradient_reference, 0.0, 1.0),
        "gradient_orientation": gradient_orientation / np.pi, "edge_strength": edge_strength, "local_variance": robust_normalize(local_variance), "local_entropy": entropy,
        "complexity": np.clip(complexity, 0.0, 1.0),
    }
    ordered = [fields[field.split(".")[-1]] for field in PIXEL_VECTOR_FIELDS]
    return np.stack(ordered, axis=-1).astype(np.float32), fields

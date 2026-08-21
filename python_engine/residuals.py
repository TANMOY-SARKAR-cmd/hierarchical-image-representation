"""Bounded quantized residual reconstruction for transparent detail recovery."""

from __future__ import annotations

from typing import Any, Dict, Tuple

import numpy as np

from geometry import rounded
from rd_optimizer import rate_distortion


def bounded_residual(original: np.ndarray, base: np.ndarray, config: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    step = max(1, int(config["residualQuantization"])); budget = max(0, int(config["residualBudgetBytes"]))
    difference = original.astype(np.int16) - base.astype(np.int16)
    magnitude = np.abs(difference).sum(axis=2)
    pixel_capacity = min(magnitude.size, budget // 8)
    keep = np.zeros(magnitude.shape, dtype=bool)
    if config.get("residualEnabled", True) and pixel_capacity:
        if pixel_capacity >= magnitude.size:
            keep[:] = magnitude > 0
        else:
            chosen = np.argpartition(magnitude.ravel(), -pixel_capacity)[-pixel_capacity:]
            keep.ravel()[chosen] = magnitude.ravel()[chosen] > 0
    quantized = np.zeros_like(difference, dtype=np.int8)
    quantized[keep] = np.clip(np.rint(difference[keep] / step), -127, 127).astype(np.int8)
    reconstruction = np.clip(base.astype(np.int16) + quantized.astype(np.int16) * step, 0, 255).astype(np.uint8)
    kept = int(keep.sum()); estimate = kept * 8
    mse = float(np.mean((original.astype(np.float32) - reconstruction.astype(np.float32)) ** 2))
    return reconstruction, quantized, {"schema": "QuantizedResidual@0.5", "quantizationStep": step, "budgetBytes": budget, "estimatedBytes": estimate, "coveredPixels": kept, "coverage": rounded(kept / max(magnitude.size, 1), 8), "heuristicRateDistortion": rate_distortion(mse, estimate, magnitude.size, config)}

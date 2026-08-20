"""Transparent rate--distortion scoring helpers for deterministic reconstruction choices."""

from __future__ import annotations

from typing import Any, Dict

from geometry import rounded


def model_score(mse_lab: float, parameter_count: int, boundary_leakage: float, config: Dict[str, Any]) -> float:
    """Penalize model complexity and boundary leakage without semantic assumptions."""
    return float(mse_lab) + float(config["modelPenalty"]) * parameter_count + float(config["boundaryLeakagePenalty"]) * float(boundary_leakage)


def rate_distortion(distortion: float, estimated_bytes: int, image_pixels: int, config: Dict[str, Any]) -> Dict[str, float]:
    normalized_rate = float(estimated_bytes) / max(int(image_pixels), 1)
    score = float(distortion) + float(config["rateDistortionLambda"]) * normalized_rate
    return {"distortion": rounded(float(distortion), 8), "estimatedBytes": int(estimated_bytes), "normalizedRate": rounded(normalized_rate, 8), "score": rounded(score, 8)}

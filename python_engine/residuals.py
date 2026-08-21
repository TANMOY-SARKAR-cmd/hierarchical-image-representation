"""Bounded quantized residual reconstruction for transparent detail recovery."""

from __future__ import annotations

import io
from typing import Any, Dict, Tuple

import numpy as np

from geometry import rounded
from rd_optimizer import rate_distortion


def _encode_sparse(indices: np.ndarray, values: np.ndarray, shape: Tuple[int, int, int], step: int) -> bytes:
    buffer = io.BytesIO()
    np.savez_compressed(buffer, indices=indices.astype(np.uint32), values=values.astype(np.int8), shape=np.array(shape, dtype=np.uint32), quantizationStep=np.array([step], dtype=np.int16))
    return buffer.getvalue()


def bounded_residual(original: np.ndarray, base: np.ndarray, config: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray, bytes | None, Dict[str, Any]]:
    step = max(1, int(config["residualQuantization"])); budget = max(0, int(config["residualBudgetBytes"]))
    difference = original.astype(np.int16) - base.astype(np.int16)
    quantized_full = np.clip(np.rint(difference / step), -127, 127).astype(np.int8)
    quantized_correction = quantized_full.astype(np.int16) * step
    squared_error_reduction = (difference.astype(np.int32) ** 2 - (difference.astype(np.int32) - quantized_correction.astype(np.int32)) ** 2).sum(axis=2)
    candidate_indices = np.flatnonzero((squared_error_reduction.ravel() > 0) & np.any(quantized_full.reshape(-1, 3) != 0, axis=1))
    candidate_limit = min(candidate_indices.size, int(config.get("maxResidualCandidatePixels", 131_072)))
    if candidate_limit < candidate_indices.size:
        candidate_reductions = squared_error_reduction.ravel()[candidate_indices]
        chosen = np.argpartition(candidate_reductions, -candidate_limit)[-candidate_limit:]
        candidate_indices = candidate_indices[chosen]
    candidate_indices = candidate_indices[np.argsort(-squared_error_reduction.ravel()[candidate_indices], kind="stable")]
    selected_indices = np.empty(0, dtype=np.int64); encoded: bytes | None = None
    if config.get("residualEnabled", True) and budget and candidate_indices.size:
        low, high = 1, candidate_indices.size
        while low <= high:
            middle = (low + high) // 2
            proposed_indices = np.sort(candidate_indices[:middle])
            proposed = _encode_sparse(proposed_indices, quantized_full.reshape(-1, 3)[proposed_indices], original.shape, step)
            if len(proposed) <= budget:
                selected_indices, encoded = proposed_indices, proposed
                low = middle + 1
            else:
                high = middle - 1
    quantized = np.zeros_like(difference, dtype=np.int8)
    if selected_indices.size:
        quantized.reshape(-1, 3)[selected_indices] = quantized_full.reshape(-1, 3)[selected_indices]
    reconstruction = np.clip(base.astype(np.int16) + quantized.astype(np.int16) * step, 0, 255).astype(np.uint8)
    kept = int(selected_indices.size); encoded_bytes = len(encoded) if encoded is not None else 0
    mse = float(np.mean((original.astype(np.float32) - reconstruction.astype(np.float32)) ** 2))
    metadata = {
        "schema": "QuantizedSparseResidual@0.7", "quantizationStep": step, "budgetBytes": budget, "actualEncodedBytes": encoded_bytes,
        "budgetMet": encoded is None or encoded_bytes <= budget, "artifactEmitted": encoded is not None, "noPayloadFitsBudget": bool(config.get("residualEnabled", True) and budget and candidate_indices.size and encoded is None),
        "candidatePixels": int(candidate_indices.size), "coveredPixels": kept, "coverage": rounded(kept / max(squared_error_reduction.size, 1), 8), "selection": "largest_rgb_squared_error_reduction_quantized_residual", "selectionObjective": "measured_rgb_squared_error_reduction_after_quantization", "selectedSquaredErrorReduction": int(squared_error_reduction.ravel()[selected_indices].sum()) if selected_indices.size else 0, "heuristicRateDistortion": rate_distortion(mse, encoded_bytes, squared_error_reduction.size, config),
    }
    return reconstruction, quantized, encoded, metadata

"""Deterministic, non-semantic local Lab appearance models for region reconstruction."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

from geometry import rounded
from rd_optimizer import model_score


MODEL_PARAMETER_COUNT = {"constant": 1, "affine": 3, "quadratic": 6}


def _design_matrix(x: np.ndarray, y: np.ndarray, model: str) -> np.ndarray:
    if model == "constant":
        return np.ones((len(x), 1), dtype=np.float64)
    if model == "affine":
        return np.column_stack((np.ones(len(x)), x, y))
    return np.column_stack((np.ones(len(x)), x, y, x * x, x * y, y * y))


def _coordinates(mask: np.ndarray) -> Tuple[np.ndarray, np.ndarray, Tuple[np.ndarray, np.ndarray]]:
    ys, xs = np.nonzero(mask)
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())
    x = ((xs.astype(np.float64) - min_x) / max(max_x - min_x, 1)) * 2.0 - 1.0
    y = ((ys.astype(np.float64) - min_y) / max(max_y - min_y, 1)) * 2.0 - 1.0
    return x, y, (ys, xs)


def _interior_boundary(mask: np.ndarray) -> np.ndarray:
    if not mask.any():
        return np.zeros_like(mask, dtype=bool)
    eroded = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), dtype=np.uint8), iterations=1).astype(bool)
    return mask & ~eroded


def _edge_weighted_boundary_residual(prediction: np.ndarray, samples: np.ndarray, boundary_selector: np.ndarray, edge_strength: np.ndarray) -> float:
    if not boundary_selector.any():
        return 0.0
    squared_error = np.mean((prediction[boundary_selector] - samples[boundary_selector]) ** 2, axis=1) / (100.0 * 100.0)
    boundary_edges = np.clip(edge_strength[boundary_selector].astype(np.float64), 0.0, None)
    normalized_edges = boundary_edges / max(float(boundary_edges.max()), 1e-12)
    return float(np.average(squared_error, weights=1.0 + normalized_edges))


def fit_appearance_model(mask: np.ndarray, rgb: np.ndarray, fields: Dict[str, np.ndarray], config: Dict[str, Any]) -> Dict[str, Any]:
    x, y, indices = _coordinates(mask)
    if all(key in fields for key in ("lab_l", "lab_a", "lab_b")):
        lab = np.stack((fields["lab_l"], fields["lab_a"], fields["lab_b"]), axis=2).astype(np.float64)
    else:
        opencv_lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float64)
        lab = np.stack((opencv_lab[:, :, 0] * (100.0 / 255.0), opencv_lab[:, :, 1] - 128.0, opencv_lab[:, :, 2] - 128.0), axis=2)
    samples = lab[indices]
    boundary_selector = _interior_boundary(mask)[indices]
    edge_samples = fields["edge_strength"][indices]
    choices: List[Dict[str, Any]] = []
    for requested in config["appearanceModelCandidates"]:
        model = str(requested)
        parameter_count = MODEL_PARAMETER_COUNT.get(model)
        if parameter_count is None or len(samples) < parameter_count * 3:
            continue
        design = _design_matrix(x, y, model)
        try:
            coefficients, _, rank, _ = np.linalg.lstsq(design, samples, rcond=None)
            if rank < parameter_count or not np.isfinite(coefficients).all():
                continue
            prediction = design @ coefficients
            mse_lab = float(np.mean((prediction - samples) ** 2))
            mse = mse_lab / (100.0 * 100.0)
            boundary_residual = _edge_weighted_boundary_residual(prediction, samples, boundary_selector, edge_samples)
            score = model_score(mse, parameter_count * 3, boundary_residual, config)
            choices.append({"model": model, "parameterCount": parameter_count * 3, "coefficients": coefficients.T.tolist(), "mseLab": mse_lab, "normalizedMseLab": mse, "boundaryResidual": boundary_residual, "score": score})
        except np.linalg.LinAlgError:
            continue
    if not choices:
        mean = samples.mean(axis=0) if len(samples) else np.zeros(3)
        choices = [{"model": "constant", "parameterCount": 3, "coefficients": [[float(value)] for value in mean], "mseLab": 0.0, "normalizedMseLab": 0.0, "boundaryResidual": 0.0, "score": 0.0}]
    selected = min(choices, key=lambda choice: (choice["score"], choice["parameterCount"]))
    return {"schema": "AppearanceModel@0.7", "coordinateSystem": "entity_local_bounding_box_normalized_minus1_to1", "selectionObjective": "normalized_cielab_squared_error_plus_model_and_boundary_penalties", "model": selected["model"], "coefficients": [[rounded(float(value), 8) for value in channel] for channel in selected["coefficients"]], "parameterCount": selected["parameterCount"], "mseLab": rounded(selected["mseLab"], 8), "normalizedMseLab": rounded(selected["normalizedMseLab"], 8), "selectionScore": rounded(selected["score"], 8), "boundaryResidual": rounded(selected["boundaryResidual"], 8), "candidates": [{"model": item["model"], "mseLab": rounded(item["mseLab"], 8), "normalizedMseLab": rounded(item["normalizedMseLab"], 8), "boundaryResidual": rounded(item["boundaryResidual"], 8), "selectionScore": rounded(item["score"], 8), "parameterCount": item["parameterCount"]} for item in choices]}


def fit_entity_models(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], rgb: np.ndarray, fields: Dict[str, np.ndarray], config: Dict[str, Any]) -> None:
    for entity in entities:
        entity["appearanceModel"] = fit_appearance_model(masks[entity["id"]], rgb, fields, config)


def reconstruct_adaptive(entities: List[Dict[str, Any]], masks: Dict[str, np.ndarray], shape: Tuple[int, int, int]) -> np.ndarray:
    lab_output = np.zeros(shape, dtype=np.float64)
    for entity in entities:
        mask = masks[entity["id"]]; x, y, indices = _coordinates(mask)
        model = entity.get("appearanceModel", {}); kind = str(model.get("model", "constant"))
        coefficients = np.asarray(model.get("coefficients", [[0.0], [0.0], [0.0]]), dtype=np.float64)
        design = _design_matrix(x, y, kind if kind in MODEL_PARAMETER_COUNT else "constant")
        prediction = design @ coefficients.T
        lab_output[indices] = prediction
    opencv_lab = np.empty_like(lab_output)
    opencv_lab[:, :, 0] = lab_output[:, :, 0] * (255.0 / 100.0)
    opencv_lab[:, :, 1] = lab_output[:, :, 1] + 128.0
    opencv_lab[:, :, 2] = lab_output[:, :, 2] + 128.0
    return cv2.cvtColor(np.clip(np.rint(opencv_lab), 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)

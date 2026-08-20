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
    height, width = mask.shape
    x = (xs.astype(np.float64) / max(width - 1, 1)) * 2.0 - 1.0
    y = (ys.astype(np.float64) / max(height - 1, 1)) * 2.0 - 1.0
    return x, y, (ys, xs)


def fit_appearance_model(mask: np.ndarray, rgb: np.ndarray, fields: Dict[str, np.ndarray], config: Dict[str, Any]) -> Dict[str, Any]:
    x, y, indices = _coordinates(mask)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float64)
    samples = lab[indices]
    boundary_leakage = float(fields["edge_strength"][mask].mean()) if samples.size else 0.0
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
            mse = float(np.mean((prediction - samples) ** 2) / (255.0 * 255.0))
            score = model_score(mse, parameter_count * 3, boundary_leakage, config)
            choices.append({"model": model, "parameterCount": parameter_count * 3, "coefficients": coefficients.T.tolist(), "mseLab": mse, "score": score})
        except np.linalg.LinAlgError:
            continue
    if not choices:
        mean = samples.mean(axis=0) if len(samples) else np.zeros(3)
        choices = [{"model": "constant", "parameterCount": 3, "coefficients": [[float(value)] for value in mean], "mseLab": 0.0, "score": 0.0}]
    selected = min(choices, key=lambda choice: (choice["score"], choice["parameterCount"]))
    return {"schema": "AppearanceModel@0.4", "model": selected["model"], "coefficients": [[rounded(float(value), 8) for value in channel] for channel in selected["coefficients"]], "parameterCount": selected["parameterCount"], "mseLab": rounded(selected["mseLab"], 8), "selectionScore": rounded(selected["score"], 8), "boundaryLeakage": rounded(boundary_leakage, 8), "candidates": [{"model": item["model"], "mseLab": rounded(item["mseLab"], 8), "selectionScore": rounded(item["score"], 8), "parameterCount": item["parameterCount"]} for item in choices]}


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
    return cv2.cvtColor(np.clip(np.rint(lab_output), 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)

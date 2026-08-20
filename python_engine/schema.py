"""Versioned schema and reproducible configuration support for the research engine."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any, Dict

SCHEMA_VERSION = "0.3.0"
SUPPORTED_VERSIONS = ("0.2.0", "0.3.0")

DEFAULT_CONFIG: Dict[str, Any] = {
    "maxImagePixels": 786_432,
    "groupingMethod": "slic",
    "hierarchyMethod": "graph_agglomerative",
    "scaleLevels": [1, 2, 4, 8],
    "slicSegments": 72,
    "slicCompactness": 10.0,
    "minimumRegionPixels": 12,
    "graphK": 3,
    "featureWeights": {"gradient": 0.35, "variance": 0.20, "edge": 0.25, "texture": 0.20},
    "groupingWeights": {"space": 0.16, "color": 0.25, "brightness": 0.12, "texture": 0.13, "gradient": 0.12, "shape": 0.12, "boundary": 0.10},
    "mergeThreshold": 0.58,
    "edgeBarrierThreshold": 0.70,
    "maxEntityAreaFraction": 0.72,
    "complexityMergePenalty": 0.35,
    "shapeWeights": {"compactness": 0.25, "orientation": 0.20, "hu": 0.55},
    "runScaleConsistency": True,
    "maxConsistencyPixels": 786_432,
}


def resolved_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    config = deepcopy(DEFAULT_CONFIG)
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key].update(value)
        else:
            config[key] = value
    config["scaleLevels"] = sorted({max(1, int(value)) for value in config["scaleLevels"]})
    if 1 not in config["scaleLevels"]:
        config["scaleLevels"].insert(0, 1)
    return config


def config_hash(config: Dict[str, Any]) -> str:
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def read_compatible_representation(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Expose a minimal stable view for v0.2 and v0.3 exports without rewriting history."""
    version = str(payload.get("representation_version") or payload.get("version") or "")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"Unsupported representation version: {version or 'missing'}.")
    if version == "0.2.0":
        return {"version": version, "entities": payload.get("entities", []), "relationships": payload.get("relationships", []), "hierarchy": payload.get("hierarchy", {}), "compatibility": "legacy-v0.2"}
    return {"version": version, "entities": payload.get("entities", []), "relationships": payload.get("relationships", []), "hierarchy": payload.get("hierarchy", {}), "compatibility": "native-v0.3"}

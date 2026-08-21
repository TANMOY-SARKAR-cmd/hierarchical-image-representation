"""Bounded deterministic parameter-sensitivity evidence for the research prototype."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Dict, List


def sensitivity_variants(config: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    """One-factor-family perturbations, bounded to prevent sensitivity sweeps becoming a service workload."""
    base = deepcopy(config)
    base["runParameterSensitivity"] = False
    base["compareSegmentationBaselines"] = False
    variants = [
        ("coarser_partition", {"slicSegments": max(8, int(base["slicSegments"] * 0.75)), "slicCompactness": min(50.0, float(base["slicCompactness"]) * 1.25)}),
        ("finer_partition", {"slicSegments": min(180, int(base["slicSegments"] * 1.25)), "slicCompactness": max(0.1, float(base["slicCompactness"]) * 0.80)}),
        ("conservative_merges", {"mergeThreshold": min(0.95, float(base["mergeThreshold"]) + 0.08), "edgeBarrierThreshold": min(1.0, float(base["edgeBarrierThreshold"]) + 0.15), "graphK": max(1, int(base["graphK"]) - 1)}),
        ("permissive_merges", {"mergeThreshold": max(0.10, float(base["mergeThreshold"]) - 0.08), "edgeBarrierThreshold": max(0.0, float(base["edgeBarrierThreshold"]) - 0.15), "graphK": min(12, int(base["graphK"]) + 1)}),
        ("native_scale_only", {"scaleLevels": [1]}),
    ]
    output: List[Dict[str, Any]] = []
    for label, changes in variants[:max(0, limit)]:
        variant = deepcopy(base); variant.update(changes); variant["sensitivityVariant"] = label
        output.append(variant)
    return output


def run_parameter_sensitivity(input_path: Path, output_dir: Path, config: Dict[str, Any], analyze: Callable[[Path, Path, Dict[str, Any]], Dict[str, Any]]) -> Dict[str, Any]:
    report_dir = output_dir / "sensitivity"
    report_dir.mkdir(parents=True, exist_ok=True)
    records: List[Dict[str, Any]] = []
    for variant in sensitivity_variants(config, int(config.get("sensitivityVariantLimit", 5))):
        label = str(variant.pop("sensitivityVariant"))
        run_dir = report_dir / label
        result = analyze(input_path, run_dir, variant)
        payload = json.loads(Path(result["representationPath"]).read_text(encoding="utf-8"))
        entity_counts: Dict[str, int] = {}
        for entity in payload["entities"]:
            entity_counts[entity["type"]] = entity_counts.get(entity["type"], 0) + 1
        records.append({
            "label": label,
            "changedConfiguration": {key: variant[key] for key in ("slicSegments", "slicCompactness", "mergeThreshold", "edgeBarrierThreshold", "graphK", "scaleLevels")},
            "entityCountByType": entity_counts,
            "relationshipCount": len(payload["relationships"]),
            "quality": {key: payload["metrics"][key] for key in ("mse", "psnr", "ssim", "processingTimeMs")},
            "artifactStorageBytes": payload["artifactStorage"]["totalBytes"],
            "configHash": payload["experiment"]["configHash"],
        })
    report = {
        "schema": "ParameterSensitivity@0.6",
        "design": "bounded_one_factor_family_perturbations",
        "referenceConfiguration": {key: config[key] for key in ("slicSegments", "slicCompactness", "mergeThreshold", "edgeBarrierThreshold", "graphK", "scaleLevels")},
        "records": records,
        "interpretation": "Deterministic internal parameter-dependence evidence only; not object-level semantic invariance or external scientific validation.",
    }
    (report_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report

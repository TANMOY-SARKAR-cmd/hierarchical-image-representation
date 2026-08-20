#!/usr/bin/env python3
"""Reproducible evaluation harness for the relational representation engine.

Synthetic fixtures are explicitly labeled as synthetic. Natural photographs and
screenshots are processed only when users provide inputs in --input-dir.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple

import numpy as np
from PIL import Image, ImageDraw, features
from skimage import data as skimage_data

from representation_engine_v2 import analyze, metrics_for


DEFAULT_CONFIG = {
    "maxFileSizeBytes": 8 * 1024 * 1024,
    "maxImagePixels": 786_432,
    "groupingMethod": "slic",
    "scaleLevels": [1, 2, 4, 8],
    "slicSegments": 72,
    "slicCompactness": 10,
    "minimumRegionPixels": 8,
    "hierarchyGroupSize": 3,
    "runScaleConsistency": False,
    "maxConsistencyPixels": 786_432,
}


def synthetic_fixtures(destination: Path) -> Iterable[Tuple[str, str, Path]]:
    destination.mkdir(parents=True, exist_ok=True)
    size = (128, 96)
    shapes = Image.new("RGB", size, "#0b1424")
    draw = ImageDraw.Draw(shapes)
    draw.rectangle((8, 10, 50, 64), fill="#2dd4bf")
    draw.ellipse((66, 18, 118, 72), fill="#fb7185")
    draw.polygon([(20, 78), (58, 90), (45, 66)], fill="#facc15")
    path = destination / "geometric-shapes.png"; shapes.save(path); yield "geometric_shapes", "synthetic", path

    gradient = np.zeros((size[1], size[0], 3), dtype=np.uint8)
    gradient[:, :, 0] = np.tile(np.linspace(0, 255, size[0], dtype=np.uint8), (size[1], 1))
    gradient[:, :, 1] = np.tile(np.linspace(255, 20, size[0], dtype=np.uint8), (size[1], 1))
    gradient[:, :, 2] = np.tile(np.linspace(80, 220, size[1], dtype=np.uint8)[:, None], (1, size[0]))
    path = destination / "gradients.png"; Image.fromarray(gradient).save(path); yield "gradients", "synthetic", path

    illustration = Image.new("RGB", size, "#f5ead9")
    draw = ImageDraw.Draw(illustration)
    draw.rounded_rectangle((18, 20, 110, 78), 12, fill="#4567b7")
    draw.ellipse((40, 28, 90, 72), fill="#f7b267")
    draw.rectangle((54, 38, 76, 45), fill="#24345a")
    path = destination / "flat-illustration.png"; illustration.save(path); yield "flat_illustration", "synthetic", path

    logo = Image.new("RGB", size, "#ffffff")
    draw = ImageDraw.Draw(logo)
    draw.regular_polygon((64, 48, 34), 6, fill="#16213e")
    draw.regular_polygon((64, 48, 18), 3, fill="#22d3ee")
    path = destination / "logo-like.png"; logo.save(path); yield "logo_like", "synthetic", path

    pixel_art = np.zeros((96, 128, 3), dtype=np.uint8)
    palette = np.array([[8, 20, 37], [21, 94, 117], [34, 211, 238], [250, 204, 21]], dtype=np.uint8)
    for y in range(12):
        for x in range(16):
            pixel_art[y * 8:(y + 1) * 8, x * 8:(x + 1) * 8] = palette[(x // 3 + y // 2) % len(palette)]
    path = destination / "pixel-art.png"; Image.fromarray(pixel_art).save(path); yield "pixel_art", "synthetic", path

    rng = np.random.default_rng(17)
    texture = rng.integers(0, 256, size=(96, 128, 3), dtype=np.uint8)
    texture = (0.65 * texture + 0.35 * np.roll(texture, 3, axis=1)).astype(np.uint8)
    path = destination / "high-texture.png"; Image.fromarray(texture).save(path); yield "high_texture", "synthetic", path

    photograph = Image.fromarray(skimage_data.astronaut()).convert("RGB")
    path = destination / "natural-photo-sample.png"; photograph.save(path); yield "natural_photo_sample", "bundled_real_photo", path


def codec_baselines() -> Dict[str, Dict[str, Any]]:
    return {
        "PNG": {"available": True, "mode": "Pillow export"},
        "JPEG": {"available": True, "mode": "Pillow export"},
        "WebP": {"available": bool(features.check("webp")), "mode": "Pillow export"},
        "AVIF": {"available": ".avif" in Image.registered_extensions(), "mode": "Pillow capability probe"},
        "VTracer": {"available": bool(shutil.which("vtracer")), "mode": "CLI capability probe"},
        "SVG": {"available": True, "mode": "engine boundary export"},
    }


def codec_comparisons(source: Path, destination: Path) -> Dict[str, Dict[str, Any]]:
    destination.mkdir(parents=True, exist_ok=True)
    original = np.asarray(Image.open(source).convert("RGB"))
    specifications = (("PNG", "PNG", {}), ("JPEG", "JPEG", {"quality": 92}), ("WebP", "WEBP", {"quality": 90}))
    results: Dict[str, Dict[str, Any]] = {}
    for name, image_format, options in specifications:
        target = destination / f"baseline.{name.lower()}"
        started = time.perf_counter()
        Image.fromarray(original).save(target, format=image_format, **options)
        reconstructed = np.asarray(Image.open(target).convert("RGB"))
        results[name] = {
            "available": True,
            "outputBytes": target.stat().st_size,
            "runtimeMs": round((time.perf_counter() - started) * 1000, 3),
            "quality": metrics_for(original, reconstructed),
            "editability": "raster",
            "hierarchyAvailability": False,
            "relationshipAvailability": False,
        }
    results["AVIF"] = {"available": ".avif" in Image.registered_extensions(), "outputBytes": None, "runtimeMs": None, "quality": None, "editability": "raster", "hierarchyAvailability": False, "relationshipAvailability": False}
    results["SVG/VTracer"] = {"available": bool(shutil.which("vtracer")), "outputBytes": None, "runtimeMs": None, "quality": None, "editability": "vector if VTracer is installed", "hierarchyAvailability": False, "relationshipAvailability": False}
    return results


def prepare_for_budget(source: Path, destination: Path) -> Tuple[Path, list[int], list[int]]:
    with Image.open(source) as image:
        rgb = image.convert("RGB")
        original_size = [rgb.width, rgb.height]
        if rgb.width * rgb.height <= DEFAULT_CONFIG["maxImagePixels"]:
            return source, original_size, original_size
        scale = (DEFAULT_CONFIG["maxImagePixels"] / (rgb.width * rgb.height)) ** 0.5
        resized = rgb.resize((max(2, int(rgb.width * scale)), max(2, int(rgb.height * scale))), Image.Resampling.LANCZOS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        resized.save(destination)
        return destination, original_size, [resized.width, resized.height]


def record_for(source: Path, category: str, provenance: str, output_dir: Path) -> Dict[str, Any]:
    analysis_source, original_dimensions, analysis_dimensions = prepare_for_budget(source, output_dir / "analysis-source.png")
    result = analyze(analysis_source, output_dir, DEFAULT_CONFIG)
    representation = json.loads(Path(result["representationPath"]).read_text(encoding="utf-8"))
    counts: Dict[str, int] = {}
    for entity in representation["entities"]:
        counts[entity["type"]] = counts.get(entity["type"], 0) + 1
    return {
        "category": category,
        "provenance": provenance,
        "file": source.name,
        "originalDimensions": original_dimensions,
        "analysisDimensions": analysis_dimensions,
        "dimensions": [representation["image"]["width"], representation["image"]["height"]],
        "pixels": representation["image"]["width"] * representation["image"]["height"],
        "entityCountByLevel": counts,
        "relationshipCount": len(representation["relationships"]),
        "representationBytes": representation["metrics"]["representationBytes"],
        "reconstructionBytes": representation["metrics"]["reconstructedBytes"],
        "quality": {key: representation["metrics"][key] for key in ("mse", "psnr", "ssim", "processingTimeMs", "representationOverhead")},
        "codecComparisons": codec_comparisons(source, output_dir / "codec-baselines"),
    }


def write_report(records: list[Dict[str, Any]], pending: list[Dict[str, str]], output_path: Path) -> None:
    payload = {"benchmarkVersion": "0.2.0", "codecBaselines": codec_baselines(), "records": records, "pendingInputCategories": pending}
    (output_path / "benchmark-report.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    lines = ["# Relational Representation Benchmark", "", "| Category | Provenance | Pixels | Entities | Edges | PSNR | SSIM | Runtime |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for record in records:
        quality = record["quality"]
        lines.append(f"| {record['category']} | {record['provenance']} | {record['pixels']} | {sum(record['entityCountByLevel'].values())} | {record['relationshipCount']} | {quality['psnr']:.2f} | {quality['ssim']:.4f} | {quality['processingTimeMs']:.1f} ms |")
    lines += ["", "## Pending user-supplied categories", ""] + [f"- `{item['category']}`: {item['reason']}" for item in pending]
    lines += ["", "This benchmark reports measurements; it does not claim superiority over image codecs or vectorizers."]
    (output_path / "benchmark-report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--input-dir")
    arguments = parser.parse_args()
    output = Path(arguments.output); output.mkdir(parents=True, exist_ok=True)
    records: list[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as fixture_directory:
        for category, provenance, source in synthetic_fixtures(Path(fixture_directory)):
            records.append(record_for(source, category, provenance, output / category))
    pending = [{"category": "natural_photograph", "reason": "Provide a licensed photograph in --input-dir."}, {"category": "screenshot", "reason": "Provide a representative screenshot in --input-dir."}]
    if arguments.input_dir:
        for source in sorted(Path(arguments.input_dir).glob("*")):
            if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                category = "screenshot" if "screenshot" in source.stem.lower() else "user_supplied"
                records.append(record_for(source, category, "user_supplied", output / source.stem))
    write_report(records, pending, output)
    print(json.dumps({"ok": True, "recordCount": len(records), "report": str(output / "benchmark-report.json")}))


if __name__ == "__main__":
    main()

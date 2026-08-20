# Hierarchical Image Representation

**Hierarchical Image Representation** is a research workbench for encoding an arbitrary image as a **multi-scale, hierarchical graph**. It preserves dense pixel vectors in NPZ tensors while exporting sparse neutral entities and explicit relationships for mathematical inspection. The project is separate from `Digital_Twin_Network`.

The browser provides inspection, visualization, and exports. The Node server validates uploads and spawns a bounded Python child process; NumPy, OpenCV, scikit-image, and SciPy perform the numerical work server-side. No semantic model, face recognition, or object classification is used.

## Version 0.2 relational upgrade

| Layer | Implemented representation |
|---|---|
| Pixel | Dense `H × W × 14` tensor containing normalized position, RGB, brightness, saturation, hue, x/y gradients, gradient magnitude, edge strength, local variance, and complexity. |
| Hierarchy | `pixel → micro_region → region → composite → entity → image`, using neutral geometric terminology. |
| Entity vector | A 20-dimensional `RegionVector` storing geometry, appearance, texture, edge, and child-count values. Higher levels use recursive area-weighted aggregation from children. |
| Graph | Sparse same-level edges built from region adjacency, spatial neighbors, and color neighbors, rather than an all-pairs graph. |
| Normalization | Distances use the image diagonal; `dx` and `dy` use image dimensions; area and brightness use directed ratios. |
| Adaptive grouping | Complexity combines gradient magnitude, local variance, and edge signal to increase requested micro-region capacity. A deterministic spatial refinement protects high-information images from collapsing into one segment. |
| Reconstruction | Level 1–4 and full PNG decodes, SVG micro-region boundaries, absolute error, and per-region error artifacts. |
| Experiment | A bounded 2× scale-consistency experiment reports normalized centroid, area, brightness, color, and nearest-neighbor stability. |

## Local development

Install Python dependencies once, then run the Node/React development server.

```bash
sudo uv pip install --system opencv-python-headless scikit-image Pillow scipy
pnpm install
pnpm dev
```

Run validation with:

```bash
python3 python_engine/test_analysis_engine.py
python3 python_engine/test_representation_engine_v2.py
pnpm test
pnpm check
pnpm build
```

Run the reproducible synthetic benchmark suite with:

```bash
python3 python_engine/benchmark_suite.py --output /tmp/hierarchical-benchmark
```

The benchmark includes geometric shapes, gradients, flat illustrations, logo-like graphics, pixel art, and high-texture synthetic data. It accepts optional user-supplied PNG, JPEG, or WebP files using `--input-dir`; natural photographs and screenshots are deliberately not fabricated as benchmark inputs.

## Configuration

| Setting | Valid range | Purpose |
|---|---:|---|
| `maxFileSizeBytes` | 256 KiB–32 MiB | Input payload limit, also constrained by the server cap. |
| `maxImagePixels` | 4,096–2,000,000 | Keeps explicit member-pixel export and synchronous analysis bounded. |
| `scaleLevels` | Subset of 1, 2, 4, 8 | Actual downsampled analysis scales, not UI zoom levels. |
| `slicSegments` | 8–180 | Baseline requested micro-region count before complexity adjustment. |
| `slicCompactness` | 0.1–50 | SLIC color/spatial tradeoff. |
| `minimumRegionPixels` | 1–500 | Tiny-label cleanup threshold. |
| `hierarchyGroupSize` | 2–8 | Deterministic child grouping count for higher-level aggregation. |
| `runScaleConsistency` | Boolean | Enables the bounded original-versus-2× normalized experiment. |

## Research limitations

This is a **representation research prototype**, not a compressed image codec or a semantic vision system. JSON member-pixel lists and dense features introduce substantial representation overhead compared with an already compressed JPEG. The UI now reports overhead explicitly rather than presenting it as compression. Higher groups are deterministic geometric aggregates; they are not claimed to correspond to semantic parts or objects. The scale experiment uses nearest normalized centroids, so it measures approximate correspondence rather than ground-truth identity.

Read [the v0.2 representation contract](docs/representation.md), [the relational architecture note](docs/relational-upgrade.md), and [the system architecture](docs/architecture.md) before changing the core schemas or registering a new grouping strategy.

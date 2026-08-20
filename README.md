# Hierarchical Image Representation

**Hierarchical Image Representation** is a fidelity-first scientific workbench for decomposing an uploaded image into dense pixel features, deterministic visual regions, hierarchy entities, and explicit relationship graphs. It is intentionally a separate project and has no implementation dependency on `Digital_Twin_Network`.

The workbench uses a Node.js application server to spawn a bounded Python analysis child process. The Python engine uses NumPy, OpenCV, and scikit-image to generate deterministic SLIC microregions, multi-scale links, aggregate hierarchy entities, raster/SVG reconstructions, and exportable artifacts. The browser is an inspection surface only; it does not execute the numerical image analysis pipeline.

## Capability summary

| Capability | Implementation |
|---|---|
| Source formats | PNG, JPEG, and WebP validation before processing |
| Feature tensor | Dense `H × W × 9` array: normalized x/y, RGB, brightness, x/y gradients, edge strength |
| Segmentation | Deterministic SLIC with connectivity enforcement and tiny-region cleanup, exposed through a strategy interface for future grouping methods |
| Entity hierarchy | Pixel → microregion → region → part → object candidate, plus image root |
| Region records | Geometry, appearance, statistics, full member-pixel coordinate list, hierarchy links |
| Relationship graph | All same-level pairs with distance, normalized distance, angle, size ratio, color/brightness differences, adjacency, overlap, and containment fields |
| Multi-scale analysis | Configurable 1×, 2×, 4×, and 8× scales with cross-scale parent links |
| Exports | Representation JSON, compressed NPZ feature arrays, reconstructed PNG, region-boundary SVG, and feature overlays |
| Quality | MSE, PSNR, SSIM, compression ratio, artifact size, and end-to-end processing time |

## Local development

The managed development server runs the Node/React application. Install the Python dependencies once in the development environment, then use the existing package scripts.

```bash
sudo uv pip install --system opencv-python-headless scikit-image Pillow
pnpm install
pnpm dev
```

Run the automated validation suite with:

```bash
python3 python_engine/test_analysis_engine.py
pnpm test
pnpm check
pnpm build
```

## Analysis configuration

The UI exposes a file-size limit, target SLIC segment count, spatial compactness, and active multi-scale factors. The server validates every submitted configuration using a typed schema. Its hard size ceiling is controlled by `MAX_IMAGE_BYTES`, which defaults to 8 MiB in the first prototype.

| Setting | Prototype range | Purpose |
|---|---:|---|
| `maxFileSizeBytes` | 256 KiB–32 MiB (server hard cap applies) | Maximum accepted upload payload |
| `maxImagePixels` | 4,096–2,000,000 | Server-enforced cap that keeps complete member-pixel exports bounded |
| `scaleLevels` | Any subset of 1, 2, 4, 8 | Resolution levels used for scale-space links |
| `slicSegments` | 8–180 | Target count for deterministic microregions at 1× |
| `slicCompactness` | 0.1–50 | Relative color/spatial balance in SLIC |
| `minimumRegionPixels` | 1–500 | Tiny-label cleanup threshold |
| `hierarchyGroupSize` | 2–8 | Deterministic agglomeration group size for higher levels |

## Deployment

The repository contains a root `Dockerfile` because the deployed Node application needs Python 3, OpenCV, scikit-image, NumPy, and Pillow at runtime. The container builds the React client and server together, then invokes `dist/index.js`; every analysis child process completes within the request lifecycle.

## Prototype limitations

This release is intentionally research-oriented. Full member-pixel lists are preserved for inspection and export, so payload size grows quickly with image dimensions. Processing is synchronous and deliberately size-capped. Higher-level groups are deterministic visual aggregates, not semantic object recognition. The SVG output visualizes region boundaries; it is not intended to replace a full vector graphics authoring system. Semantic segmentation, learned embeddings, GPU acceleration, arbitrary-resolution reconstruction, and persistent project histories remain planned extensions.

Read [the representation contract](docs/representation.md) and [the system architecture](docs/architecture.md) before extending the core data model or replacing a grouping strategy.

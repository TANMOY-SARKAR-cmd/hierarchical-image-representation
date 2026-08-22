# Hierarchical Image Representation Workbench

This separate private research workbench converts PNG, JPEG, and WebP submissions into a **deterministic, semantic-free hierarchical image representation**. A normal analysis run does not require Manus sign-in: an anonymous run receives an opaque HttpOnly browser-workspace identity, while signed-in users retain their account identity. A Node bridge validates image signatures and admission limits, then invokes a bounded server-side Python process. The browser inspects versioned JSON, dense NPZ features, sparse relationships, progressive reconstructions, and private run artifacts; it does not process images locally.

The active **v0.7.0** engine extracts RGB, HSV, explicit-unit CIELAB, continuous gradients, orientation, variance, entropy, and complexity fields; forms deterministic SLIC/watershed/Felzenszwalb micro-regions; builds sparse 4-neighbour graph candidates; and constructs one global energy-scored merge tree. Deterministic region, composite, and entity views are derived cuts of that persistent tree rather than independently rerun grouping stages. Canonical mask geometry, entity-local coordinates, and child sufficient-statistics aggregation avoid duplicated member-pixel lists. Multi-scale Hungarian best matches, fine-to-coarse overlap links, and sparse normalized overlap matrices are explicitly separate from hierarchy parentage.

Adaptive constant, affine, and quadratic entity-local CIELAB reconstruction is augmented by an optional sparse quantized residual. The residual ranks candidates by measured post-quantization RGB squared-error reduction and measures its compressed NPZ payload against a real configured byte budget. Heuristic model scores and actual emitted artifact bytes are intentionally reported separately. Optional bounded parameter-sensitivity reports expose deterministic parameter dependence; they are not semantic-invariance or external scientific-validation claims.

## Local validation

```bash
sudo uv pip install --system opencv-python-headless scikit-image Pillow scipy
pnpm dev
python3 python_engine/test_representation_engine_v3.py
python3 python_engine/test_sensitivity.py
python3 python_engine/test_benchmark_suite.py
pnpm test
pnpm check
pnpm build
```

## Browser-workspace lifecycle and live smoke verification

Anonymous jobs, results, artifact manifests, hierarchy/entity records, exact local ΔRGB samples, thresholded heatmaps, cancellation, and discard are all scoped to the same browser workspace. A durable manifest records queued, running, uploading, completed, failed, cancelled, discarded, and expired states. Server logs record only a job correlation ID and lifecycle stages; a no-progress watchdog turns an unresponsive Python job into a safe terminal failure instead of leaving it indefinitely in an early stage.

Completed result access expires after the configured retention interval. **Discard and expiry are access-only revocations**: they clear cached result/evidence references and remove the durable payload so the workbench can no longer issue them. The current managed storage adapter has no supported physical delete method, so this workbench does not claim immediate deletion of underlying platform object bytes.

Run the bounded anonymous lifecycle check against either local development or the published origin. It creates only an in-memory deterministic colour-band PNG and logs response categories, statuses, and timing—not pixels or private URLs.

```bash
HIR_SMOKE_BASE_URL=http://127.0.0.1:3000 pnpm smoke:live
HIR_SMOKE_BASE_URL=https://your-public-domain.example pnpm smoke:live
```

The smoke command verifies same-browser completion, different-browser denial, result and artifact categories, exact ΔRGB and thresholded heatmap routes, discard, and post-discard denial across all private inspection routes.

The workbench begins with source upload, a segmentation method, and a fidelity profile; expert configuration stays collapsed until requested. Completed results progressively reveal overlays, **Constant baseline**, **Adaptive model**, **Residual detail**, and **Final fidelity** outputs. Read the [v0.7 representation contract](docs/representation.md) and [architecture](docs/architecture.md) before changing core algorithms. The merge priority is a deterministic local approximation and does not claim global partition optimality. Learned grouping, neural reconstruction, semantic labels, identity processing, universal codec claims, and external scientific performance claims remain intentionally out of scope.

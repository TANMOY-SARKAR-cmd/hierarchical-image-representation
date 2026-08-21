# Hierarchical Image Representation Workbench

This separate private research workbench converts authenticated PNG, JPEG, and WebP submissions into a **deterministic, semantic-free hierarchical image representation**. A Node bridge validates image signatures and admission limits, then invokes a bounded server-side Python process. The browser inspects versioned JSON, dense NPZ features, sparse relationships, progressive reconstructions, and private run artifacts; it does not process images locally.

The active **v0.6.0** engine extracts RGB, HSV, Lab, gradient, orientation, edge, variance, entropy, and complexity fields; forms deterministic SLIC/watershed/Felzenszwalb micro-regions; builds sparse graph candidates; and constructs a connectivity-constrained `micro_region → region → composite → entity` taxonomy through iterative active-graph agglomeration. Canonical mask geometry and sufficient statistics avoid duplicated member-pixel lists. Multi-scale Hungarian best matches and fine-to-coarse overlap links are explicitly separate from hierarchy parentage.

Adaptive constant, affine, and quadratic Lab reconstruction is augmented by an optional sparse quantized residual whose compressed NPZ payload is measured against a real configured byte budget. Heuristic model scores and actual emitted artifact bytes are intentionally reported separately. Optional bounded parameter-sensitivity reports expose deterministic parameter dependence; they are not semantic-invariance or external scientific-validation claims.

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

The active CLI is `python_engine/representation_engine.py`; `representation_engine_v3.py` is a compatibility shim. Read the [v0.6 contract](docs/representation.md) and [architecture](docs/architecture.md) before changing core algorithms. Learned grouping, neural reconstruction, semantic labels, identity processing, universal codec claims, and external scientific performance claims remain intentionally out of scope.

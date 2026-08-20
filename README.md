# Hierarchical Image Representation Workbench

This separate research workbench encodes PNG, JPEG, and WebP inputs as a **graph-driven, semantic-free hierarchical image representation**. The Node server validates uploads and invokes a bounded Python child process; the browser inspects versioned JSON, dense NPZ features, reconstruction artifacts, and sparse graph relationships.

The current **v0.3.0** engine extracts RGB, HSV, Lab, gradient, orientation, edge, variance, entropy, and complexity features. It produces deterministic SLIC micro-regions, builds adjacency/spatial/appearance graph candidates, and forms a connectivity-constrained `micro_region → region → composite → entity` hierarchy. Entities use canonical mask geometry and sufficient statistics instead of duplicated member-pixel lists. Cross-resolution matching combines IoU, normalized centroid, appearance, and area costs.

## Local validation

```bash
sudo uv pip install --system opencv-python-headless scikit-image Pillow scipy
pnpm dev
python3 python_engine/test_representation_engine_v3.py
pnpm test
pnpm check
pnpm build
```

Transforms, affine/quadratic reconstruction models, residual coding, Bézier vectorization, learned grouping, and semantic labels remain later research stages. Read [the v0.3 contract](docs/representation.md), [architecture](docs/architecture.md), and [upgrade history](docs/relational-upgrade.md) before changing core algorithms.


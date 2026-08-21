# v0.5 Processing Architecture

```mermaid
flowchart TD
  U[PNG / JPEG / WebP upload] --> N[Node signature validation and bounded admission]
  N --> P[Python v0.5 engine]
  P --> F[Dense pixel feature field]
  F --> S[Deterministic SLIC micro-regions]
  S --> R[Adjacency graph and sparse candidates]
  R --> A[Fixed-depth greedy pairwise graph grouping]
  A --> H[Canonical entity hierarchy]
  H --> G[Unified relationship graph]
  S --> C[Cross-resolution correspondence]
  H --> D[Progressive reconstruction and error maps]
  G --> X[JSON, NPZ, PNG, SVG, overlays]
  C --> X
  D --> X
  X --> W[Scientific workbench]
```

The browser does not execute computer vision. Node validates canonical base64 plus MIME, extension, and binary signature agreement; applies process-local admission limits; creates an isolated temporary workspace; invokes the Python entry point with a timeout; uploads completed artifacts; and keeps the representation available for typed inspector queries.

The Python system is divided into schema/configuration, dense features, canonical geometry and sufficient statistics, segmentation, graph construction, fixed-depth grouping, correspondence, reconstruction, and orchestration modules. This preserves the server interface while allowing later experimental strategies to replace one module at a time without overstating the current grouping algorithm.

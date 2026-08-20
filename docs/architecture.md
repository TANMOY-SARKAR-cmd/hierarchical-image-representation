# v0.3 Processing Architecture

```mermaid
flowchart TD
  U[PNG / JPEG / WebP upload] --> N[Node validation and bounded child-process bridge]
  N --> P[Python v0.3 engine]
  P --> F[Dense pixel feature field]
  F --> S[Deterministic SLIC micro-regions]
  S --> R[Adjacency graph and sparse candidates]
  R --> A[Connectivity-constrained graph agglomeration]
  A --> H[Recursive canonical entity hierarchy]
  H --> G[Unified relationship graph]
  S --> C[Cross-resolution correspondence]
  H --> D[Progressive reconstruction and error maps]
  G --> X[JSON, NPZ, PNG, SVG, overlays]
  C --> X
  D --> X
  X --> W[Scientific workbench]
```

The browser does not execute computer vision. Node validates the input, creates an isolated temporary workspace, invokes the Python entry point with a timeout, uploads completed artifacts, and keeps the representation available for typed inspector queries.

The Python system is divided into schema/configuration, dense features, canonical geometry and sufficient statistics, segmentation, graph construction, hierarchy agglomeration, correspondence, reconstruction, and orchestration modules. This preserves the server interface while allowing later experimental strategies to replace one module at a time.

# v0.7 Processing Architecture

```mermaid
flowchart TD
  U[Authenticated PNG / JPEG / WebP submission] --> N[Node signature validation and per-owner bounded admission]
  N --> P[Active Python representation engine]
  P --> F[Dense explicit-unit CIELAB and continuous-gradient feature field]
  F --> S[Deterministic micro-region partition]
  S --> R[4-neighbour topology and sparse relationship candidates]
  R --> E[Global deterministic local-energy merge tree]
  E --> C[Derived region, composite, and entity cuts]
  E --> H[Explicit full-image root anchor]
  S --> M[Hungarian best matches]
  S --> O[Fine-to-coarse overlap links]
  O --> OM[Normalized sparse overlap matrices]
  C --> D[Entity-local CIELAB reconstruction]
  D --> B[Measured squared-error-selected sparse residual]
  P --> Q[Optional bounded parameter-sensitivity report]
  E --> G[Unified relationship graph]
  G --> X[Owner-scoped JSON, NPZ, PNG, SVG, overlays]
  M --> X
  OM --> X
  B --> X
  Q --> X
  X --> W[Authenticated scientific workbench]
```

The browser is an inspection and control layer; it does not execute computer vision. Node requires authentication for analysis creation and result inspection, validates canonical base64 plus MIME, extension, and binary-signature agreement, applies process-local per-owner admission limits, creates a temporary workspace, invokes `python_engine/representation_engine.py` with a timeout, uploads emitted artifacts, and keeps result metadata only in an owner-scoped bounded cache.

The active Python path combines versioned configuration, dense CIELAB feature extraction, continuous gradient boundary evidence, 4-neighbour canonical geometry, child sufficient-statistics aggregation, deterministic segmentation, sparse graph construction, a global energy-scored merge tree, deterministic cut derivation, separate cross-scale best-match and overlap evidence, entity-local adaptive reconstruction, measured sparse residual selection, sensitivity evidence, and orchestration. Historical entry points are compatibility shims or archived reference code rather than alternative active engines.

| Component | Responsibility | Key v0.7 guarantee |
|---|---|---|
| `features.py` | Builds dense pixel vectors | CIELAB units are explicit; edge strength is continuous gradient evidence |
| `geometry.py` | Computes masks, geometry, vectors, and sufficient statistics | Parents aggregate child statistics while union masks define canonical geometry |
| `hierarchy.py` | Maintains global merge candidates and derives cuts | Stable local energy ordering; no claim of global-partition optimality |
| `correspondence.py` | Produces best matches, overlap links, and sparse overlap matrices | Cross-scale evidence is never represented as hierarchy containment |
| `reconstruction_models.py` | Fits and applies region-local appearance models | Models use entity bounding-box-local coordinates and explicit CIELAB error |
| `residuals.py` | Selects and encodes a budgeted sparse correction | Candidate order follows measured post-quantization RGB squared-error reduction |
| `engine.py` | Orchestrates artifacts and representation export | Global tree, cuts, energy evidence, units, and measured storage are surfaced together |
| Server and workbench | Validates requests and exposes inspection controls | All processing remains server-side; users can inspect tree and derived-cut evidence |

The merge stage accepts only eligible touching active nodes. Its priority is a local deterministic score `ΔJ = ΔD + λR·ΔR + λB·ΔB + λS·ΔS + λC·ΔC`, subject to connectivity, area, boundary-barrier, and energy-threshold constraints. Each accepted union persists its energy components and lineage, while `derive_tree_cut()` makes the workbench’s region, composite, and entity views deterministic selections from the same persistent tree.

The workbench presents the full tree and each derived cut separately. A selected merge node displays `ΔJ` and its distortion, rate, boundary, shape, and complexity components. The interface explicitly states that the priority-queue objective is a local deterministic approximation rather than a global partition-optimality result. Existing relationship filters continue to operate over sparse graph records, independently of the hierarchy inspector.

# Relational Entity Representation Schema

## Version 0.6.0

Version **0.6.0** is a deterministic, non-semantic image-structure research workbench. It transforms an authenticated user’s submitted raster into pixel features, segmented micro-regions, a sparse relational graph, an iteratively formed containment hierarchy, multi-scale correspondence records, local Lab reconstruction models, and an optional bounded sparse residual. It is **not** a general image codec, semantic vision system, identity system, or scientifically validated universal representation.

> The engine measures colour, texture, geometry, edges, gradients, masks, and local reconstruction error. It performs no classification, face recognition, semantic inference, training, or generation.

| Layer | Primary record | Storage rule |
|---|---|---|
| Image | Dimensions, resolved configuration, experiment metadata | `representation.json` |
| Pixel features | Dense `H × W × F` tensor and micro-region labels | `features.npz` |
| Micro-region | Canonical mask geometry, sufficient statistics, local Lab model | JSON plus label field |
| Higher entity | Child IDs, union geometry, lineage and merge evidence | JSON; no duplicated pixel lists |
| Relationship graph | Sparse same-level, containment, match, and overlap records | JSON |
| Sparse residual | Quantized flat pixel indices, RGB values, shape, and step | Optional `residuals.npz` |
| Sensitivity evidence | Bounded one-factor-family parameter report | Optional `sensitivity/report.json` |

## Iterative Hierarchy and Explicit Root Semantics

The active `iterative_graph_agglomerative` method builds each fixed taxonomy transition—micro-region to region, region to composite, and composite to entity—through deterministic active-set agglomeration. It repeatedly ranks eligible adjacent graph edges by merge affinity with stable ID tie-breaking, accepts the best pair that satisfies threshold, connectedness, maximum-area, and edge-barrier constraints, recomputes geometry/statistics and candidates for the new active node, and continues until no eligible merge remains or `maxAgglomerationIterations` is reached.

Every final parent records the original lower-level child IDs and a `lineage.mergeSequence` containing iteration number, accepted affinity, touching-boundary evidence, and threshold. The root remains an explicit full-image anchor with `rootSemantics: explicit_full_image_anchor_not_inferred_agglomeration`; it is not presented as an inferred final agglomerative merge.

| Field | Meaning |
|---|---|
| `hierarchy.grouping` | Fixed-depth iterative connectivity-constrained graph agglomeration |
| `lineage.operation` | `iterative_merge`, `carry`, or `root_anchor` |
| `lineage.mergeSequence` | Ordered accepted working merges that created the parent |
| `edgeBarrierThreshold` | Rejects a candidate union across a stronger measured touching edge |
| `maxAgglomerationIterations` | Deterministic safety ceiling for one hierarchy stage |

## Cross-Scale Best Matches and Many-to-One Overlaps

Hungarian assignment remains a **one-to-one best-match diagnostic**. It is stored in `scale_correspondence.bestMatches` and retains the historical compatible `links` alias. `crossScaleMatchId` names only that selected best match; it is not a hierarchy parent field.

Version 0.6 additionally emits every fine-to-coarse overlap whose fine-mask coverage meets `crossScaleOverlapThreshold`. These records are stored in `scale_correspondence.overlapLinks` with `primaryType: cross_scale_overlap` and `semantics: fine_to_coarse_overlap_not_hierarchy_containment`. They provide a deterministic many-to-one structural view without asserting actual inter-resolution containment.

| Relationship form | Meaning |
|---|---|
| `parentId` and `contains` | True same-resolution hierarchy containment |
| `crossScaleMatchId` / `cross_scale_correspondence` | One-to-one Hungarian best-match evidence |
| `cross_scale_overlap` | Fine-to-coarse mask overlap; never a parent-child assertion |

## Adaptive Reconstruction and Real Residual Budgets

Each micro-region evaluates constant, affine, and quadratic Lab models using whole-region Lab MSE, parameter penalty, and a candidate-specific edge-weighted interior boundary-band residual. The compatible `boundaryLeakagePenalty` setting applies to this candidate-specific `boundaryResidual`; it does not measure average interior edge density or predict exterior pixels.

Residual mode ranks non-zero quantized RGB residual pixels deterministically by RGB L1 magnitude. It encodes sorted flat indices, signed quantized values, shape, and quantization step in a compressed NPZ payload, measures the resulting bytes, and retains the largest payload that fits `residualBudgetBytes`. If no valid encoded payload fits the requested budget, the run emits no `residuals.npz` file and reports `noPayloadFitsBudget` instead of pretending a synthetic capacity was met.

| Record | Basis | Appropriate use |
|---|---|---|
| `heuristicRateDistortion` | Parameter-payload estimate for model selection | Deterministic internal model comparison only |
| `residual.actualEncodedBytes` | Measured compressed sparse residual artifact bytes | Real residual-budget compliance |
| `outputs.*.artifactBytes` | Measured PNG bytes per reconstruction output | Artifact inspection |
| `artifactStorage` | Measured bytes for every emitted run file | Reproducibility and bundle accounting |

`heuristicRateDistortion` and `artifactStorage` are deliberately separate. Neither alone establishes a complete codec bit rate, perceptual rate-distortion curve, or compression claim.

## Authenticated Ownership, Admission, and Retention

Creating an analysis and reading its result, entity, hierarchy, relationships, or artifact manifest now require authentication. Every in-memory result is scoped to the submitting identity. A request for another user’s result returns `NOT_FOUND` rather than exposing whether it exists. The client starts sign-in from a user action before it submits a private analysis.

Upload admission validates canonical base64 plus consistent filename extension, MIME type, and binary signature for PNG, JPEG, or WebP. It enforces byte and pixel ceilings, temporary-workspace cleanup, a 120-second child-process limit, fixed-window per-user submission limits, and a process-local concurrent-job cap. Completed result metadata remains process-local under configurable TTL and capacity eviction; aggregate-only cache telemetry is administrator-only.

## Parameter-Sensitivity Evidence

When `runParameterSensitivity` is enabled, the server runs a bounded deterministic set of one-factor-family variations: coarser/finer SLIC partitioning, conservative/permissive merge settings, and native-scale-only analysis. `sensitivityVariantLimit` is capped at five. The resulting `ParameterSensitivity@0.6` report records changed settings, entity counts, relationship counts, PSNR/SSIM/runtime, emitted bundle bytes, and configuration hashes.

> Sensitivity output is evidence of parameter dependence for this deterministic prototype. It is not evidence of object-level semantic invariance, external scientific validation, or predictor generalization.

## Migration and Active Paths

The compatibility reader accepts exports from v0.2.0 through v0.6.0. New analyses emit v0.6.0. Historical v0.4 `crossScaleParentId` fields are exposed only as derived `crossScaleMatchId` compatibility aliases without mutating the original export.

The active CLI is `python_engine/representation_engine.py`, invoked by the server bridge. `representation_engine_v3.py` is a documented compatibility shim. Earlier engines remain in `python_engine/legacy/` for historical reference and must not be treated as active pipeline implementations.

## Privacy and Research Limits

User-provided acceptance fixtures remain private, uncommitted, and excluded from semantic inference, training, classification, identity processing, and generated content. The engine operates only on the pixels provided to the authenticated run.

The workbench’s tests, benchmarks, sensitivity reports, reconstruction metrics, and segmentation diagnostics are internal engineering evidence. Learned segmentation, neural reconstruction, object recognition, face recognition, stochastic reconstruction, universal representation claims, codec-superiority claims, and external scientific validation are intentionally out of scope.

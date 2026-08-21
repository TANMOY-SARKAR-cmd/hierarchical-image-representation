# Relational Entity Representation Schema

## Version 0.5.0

Version **0.5.0** corrects several semantic and measurement issues in the deterministic image representation workbench. It retains the non-semantic pixel-to-entity architecture while introducing a candidate-specific boundary reconstruction residual, explicit correspondence naming, separated heuristic and actual storage accounting, and bounded public submission admission. It remains a **research prototype**: its metrics are deterministic internal diagnostics, not general scientific validation or compression-codec results.

> The system encodes measured image structure only. It does not use semantic classification, identity recognition, generative synthesis, or client-side image processing.

| Layer | Primary record | Storage rule |
|---|---|---|
| Image | Dimensions, experiment metadata, resolved configuration, prototype status | JSON |
| Pixel feature field | Dense `H × W × F` tensor and `pixelToMicroregion` labels | `features.npz` |
| Micro-region | Canonical geometry, sufficient statistics, selected local Lab model | JSON plus label field |
| Higher entity | Child IDs, union geometry, derived statistics | JSON; no copied member-pixel lists |
| Relationship graph | Sparse same-level, containment, and cross-resolution correspondence records | JSON |
| Quantized residual field | Bounded deterministic detail after adaptive reconstruction | `residuals.npz` |

## Entity, Grouping, and Correspondence Semantics

`PixelVector@0.5` contains deterministic geometry, RGB/HSV/Lab appearance, gradients, edge strength, local variance, entropy, and complexity. `EntityVector@0.5` records canonical mask-union geometry, sufficient-statistics appearance, local structure, shape descriptors, and a flattened numerical vector.

The hierarchy is a **fixed-depth greedy pairwise connectivity-constrained graph grouping**, not convergence-based recursive agglomerative clustering. At each of the three fixed transitions—micro-region to region, region to composite, and composite to entity—the engine considers eligible adjacent pairs once, accepts deterministic affinity-ranked merges that satisfy area and boundary-barrier rules, and carries unmatched children forward. Parent-child relationships remain true containment relationships.

Cross-resolution Hungarian assignments are correspondences, not containment. New v0.5 entities use `crossScaleMatchId` for a selected coarse-resolution correspondence target. The `cross_scale_correspondence` relationship retains the complete match evidence.

| Relationship form | Meaning |
|---|---|
| `parentId` and containment edge | True hierarchy containment at one resolution |
| `crossScaleMatchId` | Selected cross-resolution correspondence target |
| `cross_scale_correspondence` | Hungarian match record with IoU, centroid, appearance, area, cost, and confidence |

## Adaptive Reconstruction and Boundary Residual

Each micro-region evaluates configured constant, affine, and quadratic CIE Lab candidates. The model-selection objective is deterministic and combines whole-region Lab MSE, parameter count, and an **edge-weighted interior boundary-band residual**. The boundary statistic is computed separately for every candidate using only region pixels adjacent to the exterior and is therefore capable of changing the winning model.

`boundaryLeakagePenalty` remains the compatible configuration key, but in v0.5 its documented meaning is the penalty applied to candidate-specific `boundaryResidual`. It is not a measure of average interior edge density and it does not claim to predict outside the region mask.

| Output mode | Artifact | Meaning |
|---|---|---|
| `constant` | `reconstructions/constant.png` | Constant colour per micro-region baseline |
| `parametric` | `reconstructions/parametric.png` | Selected constant/affine/quadratic Lab models |
| `residual` | `reconstructions/residual.png` | Parametric output plus bounded quantized residual |
| `full` | `reconstructions/full.png` | Progressive reconstruction compatibility output |

## Heuristic Scores and Actual Artifact Storage

The former `rateDistortion` field is replaced by `reconstruction_metadata.heuristicRateDistortion`. Its score remains useful for deterministic internal mode comparison, but it is explicitly based on estimated parameter or residual payload size rather than serialized representation storage.

`artifactStorage` is a separate v0.5 record with the measured byte count of every emitted file and the total emitted run bundle. It records actual `representation.json`, NPZ, PNG, SVG, overlay, and error-map file sizes after generation. It is descriptive run accounting; it does not feed model selection and is not a codec bit-rate claim.

| Record | Basis | Appropriate use |
|---|---|---|
| `heuristicRateDistortion` | Parameter-payload and residual estimate per pixel | Deterministic model diagnostic |
| `artifactStorage` | Actual emitted file bytes | Reproducibility and storage inspection |

## Segmentation and Cross-Scale Limits

The active primary segmentation strategy is `slic`, `watershed`, or `felzenszwalb`; unsupported direct-engine names are rejected. Multi-scale entities and reconstruction artifacts are created for every configured scale. Cross-scale correspondence is optional: `scale_consistency.status` is `completed`, `disabled`, or `skipped_pixel_limit`, while normal per-scale output remains available in all cases.

| Configuration field | Default | Effect |
|---|---:|---|
| `runScaleConsistency` | `true` | Enables the optional Hungarian correspondence experiment |
| `maxConsistencyPixels` | `786432` | Skips correspondence above this native-pixel ceiling |
| `edgeBarrierThreshold` | `0.70` | Prevents merging across a measured strong touching boundary |
| `appearanceModelCandidates` | constant, affine, quadratic | Eligible local-Lab model families |
| `modelPenalty` | `0.00045` | Penalty for model parameters |
| `boundaryLeakagePenalty` | `0.00015` | Penalty for candidate-specific boundary residual |
| `residualBudgetBytes` | `196608` | Requested residual-detail ceiling |
| `rateDistortionLambda` | `0.0015` | Weight for the explicitly heuristic model score |

## Public Submission Admission and Result Retention

The public processing route validates accepted PNG, JPEG, and WebP submissions before temporary-file creation. The request must contain canonical base64, and its declared MIME type, filename extension, and binary magic signature must agree. The server continues to enforce configured byte and pixel ceilings, temporary-workspace cleanup, and a child-process timeout.

Process-local admission control adds a fixed submission window, a per-client limit, and a global in-flight analysis cap. `ANALYSIS_SUBMISSION_WINDOW_MS`, `ANALYSIS_SUBMISSION_MAX_PER_WINDOW`, and `ANALYSIS_MAX_INFLIGHT` accept positive-integer overrides. Rejected capacity or quota requests return `TOO_MANY_REQUESTS`. These controls are instance-local prototype protections; production deployments should also use edge-level limits, authenticated tenancy, parser-security review, sandboxing, malware scanning where appropriate, and storage-policy review.

Completed interactive result metadata remains process-local for a 30-minute TTL and 100-result oldest-first capacity by default. `ANALYSIS_RESULT_TTL_MS` and `ANALYSIS_RESULT_CACHE_CAPACITY` can override these values. Immutable exported artifacts remain in storage when in-memory result metadata is expired or evicted.

## Cache-Retention Telemetry

The administrator-only `imageAnalysis.cacheTelemetry` query reports aggregate, process-local cache behavior. The workbench requests it every 15 seconds only for authenticated administrators and shows fill pressure, lifetime hits and misses, TTL/capacity evictions, and last activity. It excludes job IDs, file names, image data, artifact URLs, user data, and event history.

| Field group | Interpretation |
|---|---|
| `activeEntries`, `capacity`, `fillRatio` | Retained-result pressure; the workbench warns at 80% fill or capacity eviction |
| `writes`, `lookups`, `hits`, `misses`, `hitRate` | Aggregate effectiveness since process start |
| `expiredEvictions`, `capacityEvictions`, `totalEvictions` | TTL, oldest-first capacity, and combined removals |
| `ttlMs`, `processStartedAt`, `lastActivityAt` | Process-local retention policy and lifecycle context |

## Migration and Compatibility

The active compatibility reader accepts v0.2.0 through v0.5.0 exports. New analyses emit v0.5.0. Historical v0.4 entities may contain `crossScaleParentId`; the compatibility reader exposes a derived `crossScaleMatchId` alias without mutating the original payload. Historical `boundaryLeakage` and `rateDistortion` records remain readable as legacy data, while new v0.5 analyses write `boundaryResidual`, `heuristicRateDistortion`, and `artifactStorage`.

Inactive pre-v0.3 engine implementations are retained under `python_engine/legacy/` solely as historical reference. The active implementation is `python_engine/representation_engine_v3.py` with `python_engine/engine.py` and the active `test_representation_engine_v3.py` regression suite.

## Privacy, Limits, and Research Status

User-supplied visual acceptance fixtures remain private, uncommitted, and unused for semantic inference, training, classification, identity processing, or generated content. The engine operates only on a submitted run’s pixels.

The workbench is not scientifically validated as a general image representation, compression method, or learned visual model. Its deterministic tests, reconstruction metrics, segmentation diagnostics, and benchmark records are internal engineering evidence. Learned segmentation, neural reconstruction, object recognition, face recognition, identity-based generation, stochastic reconstruction, and general scientific performance claims remain out of scope.

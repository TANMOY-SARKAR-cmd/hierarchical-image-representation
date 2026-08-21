# Relational Entity Representation Schema

## Version 0.4.0

Version **0.4.0** retains the deterministic, connectivity-constrained graph hierarchy introduced in v0.3 and adds fidelity-oriented, non-semantic reconstruction. A representation now records three separately inspectable outputs: a constant per-region baseline, an adaptive local-Lab reconstruction, and an optional bounded residual reconstruction. It also records the selected segmentation strategy and can report comparable server-side segmentation diagnostics for SLIC, watershed, and Felzenszwalb baselines.

> The system encodes measured image structure only. It does not use semantic classification, identity recognition, generative synthesis, or client-side image processing.

| Layer | Primary record | Storage rule |
|---|---|---|
| Image | Dimensions, source bytes, experiment metadata, resolved configuration | JSON |
| Pixel feature field | Dense `H × W × F` tensor and `pixelToMicroregion` labels | `features.npz` |
| Micro-region | Canonical mask geometry, sufficient statistics, local appearance model | JSON plus label field |
| Higher entity | Child IDs, union geometry, derived statistics | JSON; no copied pixel-coordinate lists |
| Relationship graph | Sparse same-level, containment, and cross-resolution records | JSON |
| Quantized residual field | Bounded reconstruction detail after adaptive local models | `residuals.npz` |

## Feature, Entity, and Relationship Contracts

`PixelVector@0.4` groups deterministic geometry, RGB/HSV/Lab appearance, gradients, edge strength, local variance, entropy, and complexity. Pixel coordinates are normalized by image dimensions. Positive local fields use robust median/MAD normalization, while edge density and entropy remain bounded measurements.

Every entity recomputes geometry from its binary mask: bounding box, centroid, area, perimeter, compactness, orientation, and Hu descriptors. Higher entities reference child IDs rather than duplicating member pixels. `EntityVector@0.4` preserves structured geometry, appearance, local structure, and shape sections together with a flattened numerical vector.

Candidate graph edges are drawn from adjacency, spatial K-nearest neighbours, and appearance K-nearest neighbours. Same-level records retain normalized distance, directional displacement, colour and texture similarity, boundary contact, confidence, and merge affinity. Parent-child containment and Hungarian cross-resolution links remain explicit relationship records.

## Adaptive Reconstruction

Each micro-region evaluates the configured constant, affine, and quadratic local appearance candidates in CIE Lab space. The engine selects one deterministically using a penalized objective that balances colour fit, parameter count, and boundary leakage. The selected `AppearanceModel@0.4` is stored on the entity as `appearanceModel`, including its model kind, parameter count, Lab MSE, selection score, and boundary-leakage measure.

| Output mode | Artifact | Meaning | Intended comparison |
|---|---|---|---|
| `constant` | `reconstructions/constant.png` | Constant colour per micro-region | Stable fidelity baseline |
| `parametric` | `reconstructions/parametric.png` | Selected constant/affine/quadratic Lab models | Improvement from local appearance structure |
| `residual` | `reconstructions/residual.png` | Parametric result plus bounded quantized residual | Final fidelity under a defined detail budget |
| `full` | `reconstructions/full.png` | Canonical full reconstruction alias | Compatible full-output inspection |

The residual stage is optional, deterministic, and budget-bounded. Quantization step, requested budget, achieved coverage, estimated bytes, and rate-distortion score are captured in `reconstruction_metadata.residual` and `reconstruction_metadata.rateDistortion`. The residual artifact never changes the topology, geometry, hierarchy, or relationship graph.

## Segmentation and Diagnostics

The configured primary segmentation strategy is recorded in the resolved configuration. Native analyses can use `slic`, `watershed`, or `felzenszwalb`; all label fields are relabelled and small regions are deterministically merged before graph construction. Unsupported direct-engine strategy names are rejected rather than silently falling back to SLIC. When `compareSegmentationBaselines` is enabled, `segmentationDiagnostics` records server-computed summaries for each strategy, including requested segment count, actual entity count, and mean boundary edge strength.

| Configuration field | Default | Effect |
|---|---:|---|
| `segmentationStrategy` | `slic` | Selects the primary deterministic partitioning method |
| `runScaleConsistency` | `true` | Enables the optional cross-resolution correspondence experiment; it does not remove normal multi-scale artifacts |
| `maxConsistencyPixels` | `786432` | Skips correspondence when the native image exceeds this pixel ceiling |
| `edgeBarrierThreshold` | `0.70` | Blocks a graph-hierarchy merge when measured contact-boundary edge strength exceeds this value |
| `reconstructionProfile` | `balanced` | Sets a named fidelity/resource profile for the run |
| `appearanceModelCandidates` | constant, affine, quadratic | Limits eligible local-Lab model families |
| `modelPenalty` | `0.00045` | Penalizes unnecessary appearance-model parameters |
| `boundaryLeakagePenalty` | `0.00015` | Penalizes fit that leaks across region boundaries |
| `residualEnabled` | `true` | Enables bounded quantized residual detail |
| `residualQuantization` | `4` | Sets residual quantization step |
| `residualBudgetBytes` | `196608` | Caps residual-detail storage |
| `rateDistortionLambda` | `0.0015` | Weighs rate against distortion in mode scoring |

Graph agglomeration is a deterministic, adjacency-constrained **pairwise** process. The historical fixed-size `hierarchyGroupSize` setting is not part of the v0.4 request contract. A candidate pair must satisfy affinity, connectedness, area, and edge-barrier checks before it is merged; accepted parent lineage records the applied merge affinity, measured boundary edge strength, and barrier threshold.

## Cross-Scale Correspondence Limits

Multi-scale features, entities, and reconstruction artifacts are generated for every configured scale independently of the correspondence experiment. `scale_consistency.status` is `completed` only when matching runs; it is `disabled` when `runScaleConsistency` is false and `skipped_pixel_limit` when the native image exceeds `maxConsistencyPixels`. Disabled or limited runs emit no `scale_correspondence.links`, retain empty `crossScaleLinks` arrays, and record zero correspondence timing.

## Artifacts and Error Inspection

The v0.4 bundle retains `representation.json`, `features.npz`, `reconstructed.png`, and `reconstruction.svg` and adds `residuals.npz`. It also exports progressive levels, the three reconstruction modes, and error maps that distinguish constant-baseline error, parametric error, per-region error, and residual energy.

| Artifact family | Paths |
|---|---|
| Reconstructions | `reconstructions/level1.png` through `level4.png`, `full.png`, `constant.png`, `parametric.png`, `residual.png` |
| Error maps | `errors/absolute-error.png`, `parametric-error.png`, `per-region-error.png`, `residual-energy.png` |
| Overlays | Brightness, gradients, edge strength, complexity, sparse relationship graph, normalized-distance graph, residual energy |

## Formula Definitions

For source entity `i` and target entity `j`, the normalized spatial distance is `d′(i,j) = ||cᵢ - cⱼ|| / diagonal(image)`. The directed area relation is `logAreaRatio(i,j) = log((Aᵢ + ε) / (Aⱼ + ε))`.

Cross-resolution matching minimizes `C(i,j) = 0.45(1 − IoU) + 0.20Dcentroid + 0.20Dappearance + 0.15DlogArea`. Matches with `C > 0.72` are rejected, and retained correspondence confidence is `1 − C`.

For a reconstruction mode `m`, the stored rate-distortion score is `RD(m) = distortion(m) + λ × normalizedRate(m)`. This score supports transparent comparison among constant, parametric, and residual outputs; it is not a semantic quality judgment.

## Compatibility

`read_compatible_representation` accepts v0.2.0, v0.3.0, and v0.4.0 artifacts without mutating historical results. New analyses emit v0.4.0. Consumers should treat `appearanceModel`, `segmentationDiagnostics`, `reconstruction_metadata.rateDistortion`, and `residuals.npz` as v0.4 additions, while preserving the v0.3 hierarchy and relationship fields for compatible inspection.

## Completed-Result Retention

Completed result metadata is held in the server process only for interactive inspection. The default retention policy is a 30-minute TTL and a 100-result oldest-first capacity. `ANALYSIS_RESULT_TTL_MS` and `ANALYSIS_RESULT_CACHE_CAPACITY` may override these values when set to positive integers. Expired or evicted result metadata returns the existing not-found response; immutable exported artifacts remain available through their storage URLs.

## Privacy, Limitations, and Deferred Work

The user-supplied visual acceptance fixtures are private evaluation material. They remain outside version control and are not used for semantic inference, training, classification, identity processing, or generated content. The engine analyses only the pixels supplied to a server-side run and writes its inspectable artifacts for that run.

This version improves visual fidelity through deterministic local appearance fitting and bounded residual coding, not through semantic priors. Learned segmentation, neural reconstruction, object recognition, face recognition, identity-based generation, and stochastic or generative reconstruction remain intentionally out of scope. Rate-distortion scores compare the recorded deterministic modes under the selected configuration; they do not establish a universal visual-quality ranking across unrelated inputs or configurations.

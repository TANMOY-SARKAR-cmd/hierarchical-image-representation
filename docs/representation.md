# Relational Entity Representation Schema

## Version 0.7.0

Version **0.7.0** is a deterministic, non-semantic image-structure research workbench. An authenticated image submission is represented as dense pixel features, segmented micro-regions, a sparse relationship graph, a persistent global merge tree, deterministic derived cuts, multi-scale correspondence evidence, entity-local CIELAB reconstruction models, and an optional bounded sparse residual. It is **not** a general image codec, semantic vision system, identity system, or scientifically validated universal representation.

> The engine measures colour, texture, geometry, continuous gradients, masks, and local reconstruction error. It performs no classification, face recognition, semantic inference, training, or identity-based generation.

| Layer | Primary record | Storage rule |
|---|---|---|
| Image | Dimensions, resolved configuration, experiment metadata | `representation.json` |
| Pixel features | Dense `H × W × F` tensor and micro-region labels | `features.npz` |
| Micro-region | Canonical mask geometry, `SufficientStatistics@0.7`, local appearance model | JSON plus label field |
| Merge tree | Binary merge nodes, child IDs, local-energy evidence, canonical union geometry | JSON; no duplicated pixel lists |
| Derived cut | Region, composite, or entity node IDs selected from the merge tree | `hierarchy.cuts` |
| Relationship graph | Sparse same-level, containment, best-match, and overlap records | JSON |
| Sparse residual | Quantized flat RGB residual indices, values, shape, and step | Optional `residuals.npz` |
| Sensitivity evidence | Bounded one-factor-family parameter report | Optional `sensitivity/report.json` |

## Explicit Feature Units and Topology

The active pipeline uses **4-neighbour** contact for masks, adjacency, connectivity validation, perimeter calculation, and merge eligibility. Diagonal-only contact is not adjacency. CIELAB is stored explicitly as `L*` in `0–100` and `a*`/`b*` in their signed CIELAB units. Relationship colour distance is named `colorDistanceDeltaE76` and uses those stated units.

| Field or rule | v0.7 contract |
|---|---|
| `feature_schema.PixelVector.units.lab_l` | `CIELAB_Lstar_0_to_100` |
| `feature_schema.PixelVector.units.lab_a`, `lab_b` | Signed CIELAB `a*`, `b*` units |
| `edge_strength` | Continuous robust-normalized gradient magnitude, not a binary Canny mask |
| `topology` | `4-neighbour` |
| Parent statistics | Aggregated exactly from child sufficient statistics, then paired with canonical union-mask geometry |
| Entity coordinates | Explicit local coordinate metadata; no hidden whole-image coordinate assumption |

## Global Energy-Scored Merge Tree and Derived Cuts

The active `global_energy_merge_tree` method starts at native-resolution micro-regions and maintains a priority queue of current, touching, eligible active-node pairs. Every accepted union is persisted as a binary tree node. The queue is recomputed around an accepted union and tie-broken by stable IDs, which makes the operation deterministic for a fixed input and configuration.

Candidate unions use the local objective below. `ΔD` is CIELAB variance change, `ΔR` is a local entity-count reduction proxy, `ΔB` is continuous boundary strength, `ΔS` is compactness degradation, and `ΔC` is complexity increase. The configurable weights are stored in `mergeEnergyWeights`.

> `ΔJ = ΔD + λR·ΔR + λB·ΔB + λS·ΔS + λC·ΔC`

An accepted merge must remain 4-neighbour connected, respect `maxEntityAreaFraction`, pass the continuous `edgeBarrierThreshold`, and satisfy `mergeEnergyThreshold`. This is a **deterministic local approximation**, not a claim of globally optimal partitioning.

The tree is the authoritative hierarchy. Region, composite, and entity views are deterministic cuts produced by expanding largest-leaf-count tree nodes until each configured target count is reached. They are not separately rerun grouping stages. The image root remains an explicit full-image anchor with `rootSemantics: explicit_full_image_anchor_not_inferred_agglomeration`.

| Field | Meaning |
|---|---|
| `hierarchy.grouping` | `global_energy_scored_4_neighbour_merge_tree_with_derived_cuts` |
| `hierarchy.treeNodeIds` / `treeRootIds` | Persistent binary merge nodes and disconnected tree roots, if any |
| `hierarchy.mergeEvidence` | Accepted/rejected candidate evidence with local energy components |
| `hierarchy.cuts` | Deterministic region, composite, and entity node selections |
| `lineage.operation` | `segment`, `energy_merge`, or `root_anchor` |
| `lineage.mergeEvidence.energy` | `deltaJ`, `deltaDistortion`, `deltaRate`, `deltaBoundary`, `deltaShape`, and `deltaComplexity` |
| `derivedCutTargetFractions` | Requested fractions for region, composite, and entity cuts |

## Cross-Scale Best Matches, Overlaps, and Sparse Matrices

Hungarian assignment is a **one-to-one best-match diagnostic**. It is stored in `scale_correspondence.bestMatches` and retains the compatible `links` alias. `crossScaleMatchId` names only that diagnostic best match; it is never a hierarchy parent field.

Fine-to-coarse overlap records meeting `crossScaleOverlapThreshold` are stored in `scale_correspondence.overlapLinks` with `primaryType: cross_scale_overlap` and `semantics: fine_to_coarse_overlap_not_hierarchy_containment`. `scale_correspondence.normalizedOverlapMatrix` packages those same records into sparse fine-row-normalized matrices. Each row records coverage retained by thresholded links, uncovered fraction, and nonzero target entries. Omitted entries mean zero and do not imply containment.

| Relationship form | Meaning |
|---|---|
| `parentId` and `contains` | True same-resolution merge-tree containment |
| `crossScaleMatchId` / `cross_scale_correspondence` | One-to-one Hungarian best-match evidence |
| `cross_scale_overlap` | Fine-to-coarse mask overlap; never a parent-child assertion |
| `NormalizedFineToCoarseOverlapMatrix@0.7` | Sparse coverage matrix derived from thresholded overlap records |

## Adaptive Reconstruction and Real Residual Budgets

Each micro-region fits constant, affine, and quadratic **entity-local** CIELAB models. Local coordinates are normalized over that entity’s own bounding box to `[-1, 1]`; coefficients are not fitted against hidden full-image coordinates. The selected `AppearanceModel@0.7` exposes `normalizedMseLab`, raw CIELAB `mseLab`, candidate-specific edge-weighted boundary residual, model parameter count, and the selection objective `normalized_cielab_squared_error_plus_model_and_boundary_penalties`.

Residual mode quantizes RGB correction candidates and ranks them by their **measured post-quantization RGB squared-error reduction**, rather than RGB L1 magnitude. It encodes sorted flat indices, signed quantized values, shape, and quantization step in a compressed NPZ payload, then retains the largest prefix that actually fits `residualBudgetBytes`. `QuantizedSparseResidual@0.7` records this selection objective and measured selected error reduction. If no valid payload fits, the run emits no `residuals.npz` file and reports `noPayloadFitsBudget` rather than claiming synthetic capacity.

| Record | Basis | Appropriate use |
|---|---|---|
| `appearanceModel.mseLab` | Measured CIELAB squared error in explicit units | Local model inspection |
| `appearanceModel.normalizedMseLab` | `mseLab / 100²` | Deterministic model-score component |
| `residual.actualEncodedBytes` | Measured compressed sparse residual artifact bytes | Real residual-budget compliance |
| `residual.selectedSquaredErrorReduction` | Measured retained RGB squared-error reduction after quantization | Sparse-candidate evidence |
| `heuristicRateDistortion` | Parameter-payload estimate for model selection | Internal comparison only |
| `artifactStorage` | Measured bytes for every emitted run file | Reproducibility and bundle accounting |

`heuristicRateDistortion` and `artifactStorage` remain deliberately separate. Neither establishes a complete codec bit rate, perceptual rate-distortion curve, or compression claim.

## Authenticated Ownership, Admission, and Retention

Creating an analysis and reading its result, entity, hierarchy, relationships, or artifact manifest require authentication. Every in-memory result is scoped to the submitting identity. A request for another user’s result returns `NOT_FOUND` rather than exposing whether it exists.

Upload admission validates canonical base64 plus consistent filename extension, MIME type, and binary signature for PNG, JPEG, or WebP **before** accepting an asynchronous job. It enforces byte and pixel ceilings, temporary-workspace cleanup, a 120-second child-process limit, fixed-window per-user submission limits, and a process-local concurrent-job cap. A durable owner-scoped manifest records queued, running, uploading, completed, failed, cancelled, and discarded availability states. Completed result payloads can be restored after process-local cache eviction until their configured expiry; aggregate-only cache telemetry is administrator-only.

Users may cancel an in-flight analysis through the workbench. A cancellation terminates the active Python child process, records a terminal `cancelled` state, and never exposes a partial result. Users may also discard a completed analysis from the workbench. Discarding removes cached result and inspection evidence and revokes the manifest payload and workbench artifact references. The current storage interface does not expose physical object deletion, so discard is access revocation rather than an assertion of immediate backend byte erasure.

Thresholded ΔRGB previews are rendered server-side from private exact evidence, returned as bounded in-memory data URLs, and never create a new persistent storage object for each slider threshold.

## Merge Calibration and Canonical Relationships

New analyses use a conservative `mergeEnergyThreshold` default of `0.05`. This accepts evidence-backed low-cost merges on eligible structured fixtures while retaining the existing boundary and area guards. Continuous gradients and texture-dominated inputs can correctly retain zero accepted merges when no candidate satisfies the energy criterion; a zero-merge result is therefore diagnostic evidence, not a hidden failure.

Derived region, composite, and entity cuts can resolve to the same tree nodes in a shallow hierarchy. Equivalent sparse graph records are emitted once with `derivedCutViews` membership rather than repeated as indistinguishable edge payloads. The retired `mergeThreshold` field is not part of the active public or serialized configuration contract.

## Parameter-Sensitivity Evidence

When `runParameterSensitivity` is enabled, the server runs a bounded deterministic set of one-factor-family variations: coarser/finer SLIC partitioning, conservative/permissive **merge-energy and boundary-barrier** settings, and native-scale-only analysis. `sensitivityVariantLimit` is capped at five. The resulting `ParameterSensitivity@0.7` report records changed settings, entity counts, relationship counts, PSNR/SSIM/runtime, emitted bundle bytes, and configuration hashes.

> Sensitivity output is evidence of parameter dependence for this deterministic prototype. It is not evidence of object-level semantic invariance, external scientific validation, or predictor generalization.

## Migration and Active Paths

The compatibility reader accepts exports from v0.2.0 through v0.7.0. New analyses emit v0.7.0. Historical v0.4 `crossScaleParentId` fields are exposed only as derived `crossScaleMatchId` compatibility aliases without mutating the original export.

The active CLI is `python_engine/representation_engine.py`, invoked by the server bridge. `representation_engine_v3.py` is a documented compatibility shim. Earlier engines remain in `python_engine/legacy/` for historical reference and must not be treated as active pipeline implementations.

## Privacy and Research Limits

User-provided acceptance fixtures remain private, uncommitted, and excluded from semantic inference, training, classification, identity processing, and generated content. The engine operates only on pixels provided to the authenticated run.

The workbench’s tests, benchmarks, sensitivity reports, reconstruction metrics, and segmentation diagnostics are internal engineering evidence. Learned segmentation, neural reconstruction, object recognition, face recognition, stochastic reconstruction, universal representation claims, codec-superiority claims, and external scientific validation are intentionally out of scope.

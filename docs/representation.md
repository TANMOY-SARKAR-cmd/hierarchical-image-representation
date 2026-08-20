# Relational Entity Representation Schema

## Version 0.3.0

Version **0.3.0** replaces arbitrary fixed-size parent grouping with deterministic, connectivity-constrained graph agglomeration. Exports retain the v0.2 artifact locations, and `read_compatible_representation` reads both versions without rewriting historical v0.2 results.

| Layer | Primary record | Storage rule |
|---|---|---|
| Image | Dimensions, source bytes, experiment metadata | JSON |
| Pixel feature field | Dense `H × W × F` tensor | `features.npz` |
| Micro-region | Canonical mask-derived entity | JSON plus integer label field |
| Higher entity | Child IDs, sufficient statistics, union geometry | JSON; no duplicated pixel-coordinate lists |
| Relationship graph | Sparse same-level, containment, and cross-resolution records | JSON |

## Pixel Feature Field

`PixelVector@0.3` groups features into geometry, appearance, and local structure. It includes RGB, lightness, HSV, normalized Lab, gradient components and orientation, edge strength, local variance, entropy, and complexity. Coordinates are normalized by image dimensions. Positive local fields use robust median/MAD normalization; edge density and entropy remain bounded unit measures.

## Entity Model

Every entity recomputes canonical geometry from its current binary mask: bounding box, centroid, area, perimeter, compactness, and orientation. Sufficient statistics retain count, sum, and sum of squares for the primary fields. `EntityVector@0.3` contains structured geometry, appearance, structure, and Hu-moment shape sections plus a flattened numerical vector.

> Leaf membership is retained only as `pixelToMicroregion` in the NPZ artifact. Higher entities reference children; they do not copy member-pixel lists.

## Relationship Model

Candidate edges are the union of region adjacency, spatial K-nearest neighbours, and appearance K-nearest neighbours. `candidateSources` preserves why every edge exists. Same-level records include normalized distance, directional displacement, log area and brightness ratios, normalized Lab distance, texture and shape similarity, boundary contact, confidence, and `mergeAffinity`.

`normalizedDistance = distance / image_diagonal`; `logAreaRatio = log((sourceArea + ε) / (targetArea + ε))`; and `logBrightnessRatio = log((sourceBrightness + ε) / (targetBrightness + ε))`. Parent-to-child records are explicit `contains` edges. Cross-resolution correspondence uses minimum-cost matching over IoU, normalized centroid distance, appearance difference, and log-area difference.

## Hierarchy, Reconstruction, and Scope

The hierarchy is `pixel → micro_region → region → composite → entity → image`. A merge is allowed only when its candidate pair is adjacent, sufficiently affine, below the size bound, and forms a connected mask union. The export records leaf coverage, parent-area conservation, connectivity, cycle count, and duplicate-storage status.

The v0.3 reconstruction remains a constant appearance model with progressive level PNGs, error maps, PSNR, SSIM, MSE, and artifact sizes. Transform stacks, affine/quadratic fields, residual coding, Bézier geometry, learned grouping, and semantic hypotheses are intentionally deferred until structural validity has been evaluated.

## v0.2 to v0.3 Migration

| v0.2 field or behavior | v0.3 replacement | Compatibility treatment |
|---|---|---|
| `RegionVector@0.2` | Structured `EntityVector@0.3` plus flattened values | Reader accepts both; new analyses emit v0.3 only |
| `memberPixels` on each entity | Dense `pixelToMicroregion` plus child references | Removed from v0.3 entities to avoid duplicate storage |
| Fixed groups of three | Connectivity-constrained graph agglomeration | Superseded for new analyses |
| Nearest-centroid scale link | IoU/centroid/appearance/area cost assignment | Replaced for native micro-region correspondence |
| `scaleFactor` terminology | `resolutionFactor` plus retained `scaleFactor` alias | Alias retained for client compatibility |

## Formula Definitions

For source entity `i` and target entity `j`, the normalized spatial distance is

`d′(i,j) = ||cᵢ - cⱼ|| / diagonal(image)`.

The directed area relation is

`logAreaRatio(i,j) = log((Aᵢ + ε) / (Aⱼ + ε))`.

The merge affinity combines configured spatial, appearance, brightness, texture, gradient, shape, and boundary terms. Higher edge density and local complexity lower the final merge score. A candidate is only merged if it is adjacent, exceeds the configured threshold, remains below the configured area bound, and yields one connected union mask.

Cross-resolution matching minimizes

`C(i,j) = 0.45(1 − IoU) + 0.20Dcentroid + 0.20Dappearance + 0.15DlogArea`.

Matches with `C > 0.72` are rejected. Retained correspondence confidence is `1 − C`.

# Representation Contract — Version 0.2.0

The versioned export is a portable representation artifact, not a frontend view model. It uses pixel coordinates `[x, y]` and inclusive bounding boxes `[minX, minY, maxX, maxY]`. Backward-compatible aliases (`image`, `scaleLevels`, and `metrics`) are retained alongside the explicit v0.2 names.

| Top-level field | Purpose |
|---|---|
| `representation_version` | Current schema identifier: `0.2.0`. |
| `image_metadata` | Source dimensions, channel count, and source byte length. |
| `feature_schema` | Pixel and region vector fields, dimensions, and NPZ storage locations. |
| `scales` | Per-scale dimensions, entity count, segmentation characteristics, reconstruction error, and cross-scale links. |
| `entities` | Hierarchy records with intrinsic geometry, appearance, statistics, vector, parent, children, and cross-scale parent. |
| `relationships` | Sparse normalized relationship graph records. |
| `aggregation_methods` | Rules for deriving higher-level vectors from children. |
| `normalization_methods` | Definitions for scale-relative graph fields. |
| `reconstruction_metadata` | Level-specific decodes and error-map artifact locations. |
| `quality_metrics` | MSE, PSNR, SSIM, source/artifact size, overhead, and runtime. |
| `profiling` | Feature, segmentation, aggregation, graph, reconstruction, consistency, and serialization timing. |

## PixelVector

`features.npz` stores `pixelVectors` as a dense `H × W × 14` `float32` tensor. Pixels are not expanded into heavyweight JSON objects. `pixelToMicroregion` maps each source pixel to a level-1 micro-region label.

| Ordered fields | Meaning |
|---|---|
| `x`, `y` | Normalized source coordinates. |
| `red`, `green`, `blue` | RGB channels scaled to `[0, 1]`. |
| `brightness` | Grayscale intensity. |
| `saturation`, `hue` | HSV appearance components. |
| `gradient_x`, `gradient_y`, `gradient_magnitude` | Local brightness derivatives. |
| `edge_strength` | Canny edge response. |
| `local_variance` | 5×5 brightness-window variance. |
| `complexity` | Normalized weighted combination of gradients, local variance, and edge signal. |

## RegionVector and recursive aggregation

Every micro-region has a `RegionVector@0.2` with 20 values: centroid, bounding-box origin/size, area, perimeter, compactness, orientation, mean RGB, color variance, brightness mean/variance, gradient, edge density, texture, and child count.

Higher levels do not calculate an unrelated feature vector. Their values are derived from children using area-weighted means, union bounding boxes, summed area/perimeter, circular orientation aggregation, and explicit child-count statistics. Each vector reports both `provenance` and `aggregation` so consumers can distinguish direct pixel aggregates from recursive child aggregates.

## Sparse relationship graph

Relationship construction is **not** `O(N²)`. At each hierarchy level, candidate edges are the union of region-adjacency edges, three nearest normalized-centroid neighbors, and three nearest appearance neighbors. The resulting build complexity is `O(N log N + E)` for `N` sparse entities and `E` retained edges; pixels remain a dense tensor with implicit grid connectivity.

Each relationship has `sourceId`, `targetId`, `relationshipType`, `primaryType`, distance, normalized distance, `dx`, `dy`, normalized deltas, size/area ratio, brightness difference/ratio, color distance/similarity, shape and texture similarity, overlap ratio, boundary contact ratio, containment state/ratio, adjacency, and confidence.

> `normalizedDistance = distance / image_diagonal`; `normalizedDx = dx / image_width`; `normalizedDy = dy / image_height`; and directed area/brightness ratios include a small epsilon for stability.

The graph stores meaningful relations such as `adjacent`, `near`, `similar_color`, `similar_shape`, `source_in_target`, and `target_in_source`. It intentionally does not claim semantic entity labels.

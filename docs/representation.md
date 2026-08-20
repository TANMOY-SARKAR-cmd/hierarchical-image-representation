# Representation Contract

The exported `representation.json` file is versioned (`1.0.0`) and uses pixel coordinates in the form `[x, y]`. A bounding box is expressed as `[minX, minY, maxX, maxY]` with inclusive maxima. The contract separates dense numerical arrays from interpretable entities and relationships.

| Top-level field | Description |
|---|---|
| `configuration` | Exact validated settings used to reproduce the run |
| `image` | Source dimensions, channel count, and source byte count |
| `features` | Dense tensor shape, ordered channel names, and NPZ artifact reference |
| `scaleLevels` | Per-scale dimensions, microregion IDs, tensor shape, and cross-scale links |
| `hierarchy` | Exact required named levels and the image-root entity ID |
| `entities` | Geometry, appearance, statistics, member pixels, hierarchy, and cross-scale links |
| `relationships` | Pairwise same-level graph records |
| `artifacts` | Relative names of NPZ, PNG, SVG, and overlay files |
| `metrics` | Reconstruction quality, artifact size, compression ratio, and runtime |

## Entity structure

Every entity has `id`, `type`, `level`, `scaleFactor`, `geometry`, `appearance`, `statistics`, `memberPixels`, `children`, `parentId`, and `crossScaleParentId`. The required entity type names are `microregion`, `region`, `part`, and `object_candidate`. The representation additionally has an `image` root to anchor the entity tree.

The complete `memberPixels` array is intentional for this research prototype. The `pixelLevel` object also makes the dense pixel-to-microregion hierarchy first-class: the `pixelToMicroregion` array in NPZ stores one microregion label per source pixel, and `labelToMicroregionId` resolves that label to an entity.

## Relationship structure

Every pair of entities at a common hierarchy level produces a relationship record with `sourceId`, `targetId`, `entityLevel`, `distance`, `normalizedDistance`, `angle`, `sizeRatio`, `colorDifference`, `brightnessDifference`, `adjacent`, `overlap`, and `containment`.

`normalizedDistance` equals centroid distance divided by the source image diagonal. `sizeRatio` is source area divided by target area. `containment` is computed as `source_in_target`, `target_in_source`, or `none`. The first SLIC-derived sibling records are typically mutually exclusive, but the directional computation is retained for future overlap-aware algorithms.

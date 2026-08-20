# Relational Representation Upgrade

The first implementation established deterministic pixel features, SLIC micro-regions, a hierarchy tree, and reconstruction exports. Version 0.2 changes the architectural emphasis from a segmentation tree to a **hierarchical relational representation**.

## What was added

| Area | v0.2 addition |
|---|---|
| Mathematical schema | Explicit PixelVector and RegionVector contracts with ordered fields and dimensions. |
| Hierarchy semantics | Neutral `micro_region`, `region`, `composite`, and `entity` names replace premature semantic labels. |
| Recursive structure | Parent vectors are visibly marked as child-derived and include child-area distribution statistics. |
| Relationship graph | Sparse relevant edges with normalized geometry, appearance, shape, texture, contact, overlap, containment, type, and confidence fields. |
| Inspection | Relationship graph overlays, error maps, level-specific decode selector, vector context, strong-edge matrix, and scale-consistency telemetry. |
| Evaluation | A repeatable benchmark harness with synthetic fixture provenance and capability probes for PNG/JPEG/WebP/AVIF/SVG/VTracer baselines. |

## Reconstruction and error interpretation

Each decode level is an intentionally different abstraction. Level 1 retains micro-region mean color; levels 2–4 progressively render neutral parent groups; `full` is the level-1 representation export retained for compatibility. Absolute error maps and per-region error maps identify where global PSNR or SSIM obscure local failure.

## Scale-consistency experiment

The engine re-encodes a 2× resized source when the configured pixel budget permits it. It matches micro-regions by nearest normalized centroid and reports normalized centroid, area, brightness, color, and nearest-neighbor spacing stability. These are experimental correspondence measurements, not a claim of strict scale invariance.

## Known limitations and next research steps

The hierarchy is still deterministic and geometry-led. It does not learn semantic identity, optimize global graph structure, compact member-pixel lists, or provide ground-truth cross-scale correspondences. The most useful next research steps are to evaluate user-provided natural photos and screenshots, compare more codecs/vectorizers under the same constraints, test relationship-preserving transforms, and experiment with richer non-semantic grouping strategies before adding semantic AI.

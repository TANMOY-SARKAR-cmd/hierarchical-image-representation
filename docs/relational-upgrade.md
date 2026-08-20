# Relational Upgrade History

| Version | Structural capability | Status |
|---|---|---|
| 0.2 | Deterministic geometric hierarchy, explicit vectors, sparse graph inspection | Preserved through compatibility reader |
| 0.3 | Graph-driven hierarchy, canonical mask geometry, sufficient statistics, unified relations, cross-resolution matching | Implemented |
| 0.4 | Transformable hierarchy with structural and appearance operation history | Deferred |

Version 0.3 replaces the previous fixed groups-of-three hierarchy. It remains deterministic and semantic-free: an `entity` is a structurally coherent image region, not an inferred class. The next research sequence is transform propagation, adaptive reconstruction models, rate-distortion evaluation, vector geometry, and only then optional semantic hypotheses.

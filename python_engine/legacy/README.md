# Historical Engine Archive

This directory contains inactive pre-v0.3 engine paths retained solely as historical reference material. They are **not imported by the active server bridge**, are not part of the v0.5 validation suite, and must not be used for new analyses.

| Archived path | Historical role | Active replacement |
|---|---|---|
| `analysis_engine.py` | Early analysis prototype | `../engine.py` |
| `representation_engine_v2.py` | v0.2 command-line implementation | `../representation_engine_v3.py` and `../engine.py` |
| `test_analysis_engine.py` | Early prototype tests | `../test_representation_engine_v3.py` |
| `test_representation_engine_v2.py` | v0.2 regression tests | `../test_representation_engine_v3.py` |

Representation readers continue to support historical v0.2, v0.3, and v0.4 artifact payloads through the active `schema.py` compatibility reader. New work must target the active v0.5 contract.

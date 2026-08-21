# Relational Representation Benchmark

| Category | Provenance | Pixels | Entities | Edges | Constant PSNR | Model PSNR | Residual PSNR | Runtime |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| geometric_shapes | synthetic | 12288 | 66 | 326 | 44.21 | 41.46 | 51.23 | 1805.8 ms |
| gradients | synthetic | 12288 | 92 | 322 | 31.30 | 30.89 | 46.29 | 1468.6 ms |
| flat_illustration | synthetic | 12288 | 61 | 299 | 99.00 | 53.22 | 53.22 | 1459.3 ms |
| logo_like | synthetic | 12288 | 69 | 363 | 99.00 | 51.40 | 52.44 | 2100.0 ms |
| pixel_art | synthetic | 12288 | 111 | 546 | 52.99 | 43.69 | 50.39 | 1512.1 ms |
| high_texture | synthetic | 12288 | 5 | 4 | 13.40 | 13.28 | 46.39 | 363.8 ms |
| natural_photo_sample | bundled_real_photo | 262144 | 108 | 503 | 15.02 | 16.81 | 25.06 | 17953.9 ms |

The report records iterative structural grouping, three deterministic reconstruction modes, heuristic model scores, actual sparse residual artifact bytes, actual emitted storage, and server-side SLIC/watershed/Felzenszwalb diagnostics for every fixture.

## Pending user-supplied categories

- `natural_photograph`: Provide a licensed photograph in --input-dir.
- `screenshot`: Provide a representative screenshot in --input-dir.

This research-prototype benchmark reports deterministic internal measurements; it does not claim scientific validation, codec bit-rate equivalence, or superiority over image codecs or vectorizers.
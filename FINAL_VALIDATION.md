# Syna v0.4.0 final validation

- Git commit: `26caf4d7cfa7bbfc86516d6df932b17be25348e2`
- Strict TypeScript build and type tests: passed
- Runtime tests: **88 passed, 0 failed, 0 skipped**
- Demos: minimal, Hyla/BASM-like, Fluida-like, features — passed
- Coverage: **97.17% lines, 90.31% branches, 87.83% functions**
- Clean tarball smoke project: `{"result": 42, "revision": "7.3.1"}`
- Core TypeScript source files: 19
- Runtime test files: 9

## Cache benchmark invariants

- Selector request path: {'hits': 4396, 'misses': 5, 'entries': 5, 'evictions': 0, 'maxEntries': 32}
- Binding request path: {'hits': 1098, 'misses': 3, 'entries': 3, 'evictions': 0, 'maxEntries': 32}
- 500-shape LRU churn: {'hits': 0, 'misses': 500, 'entries': 16, 'evictions': 484, 'maxEntries': 16}

Raw logs are in `validation/v0.4-release/`; benchmark data is in `benchmarks/results-v0.4.0.json`.

## Artifact verification

- ZIP integrity: passed (`unzip -t`, no errors).
- Source archive contents: 318 entries, 19 core source files, 9 runtime test files.
- Freshly extracted ZIP: **88 tests passed, 0 failed** using the included build output.
- Published tarball smoke project: TypeScript compile and runtime result `{"result":42,"revision":"7.3.1"}`.

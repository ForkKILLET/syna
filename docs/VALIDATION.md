# Validation (VALIDATION)

All numbers below are copied from machine-readable results produced by the transparent orchestrator; nothing is hand-written. The **release** run (`node scripts/verify-v05.mjs --release`) is the authoritative record: see `RELEASE_MANIFEST.json`, `validation/v0.5-release/` and `SHA256SUMS.txt`. This page summarizes the development gate that preceded it and will be refreshed from the release manifest.

## Environment (development gate)

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL 17.10 (Homebrew) temporary cluster created by `scripts/pg-test-cluster.mjs` (port 54329, `fsync=off`), removed after each run
- Source fingerprint of the dev run: `1ef01e472aa7fc89cae613fec39f831536a32717b7a03a26f150e4423fbe606c` (172 files)

## Development gate steps (`validation/v0.5-dev/manifest.json`, status COMPLETE)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 170 ms | `validation/v0.5-dev/logs/clean.log` |
| build | 0 | — | 1741 ms | `validation/v0.5-dev/logs/build.log` |
| type-tests | 0 | — | 563 ms | `validation/v0.5-dev/logs/type-tests.log` |
| core-tests | 0 | 130/130 pass, 0 fail, 0 skipped | 538 ms | `validation/v0.5-dev/logs/core-tests.log` |
| hyla-filesystem-tests | 0 | 43/43 pass, 0 fail, 0 skipped | 614 ms | `validation/v0.5-dev/logs/hyla-filesystem-tests.log` |
| hyla-render-tests | 0 | 4/4 pass, 0 fail, 0 skipped | 244 ms | `validation/v0.5-dev/logs/hyla-render-tests.log` |
| hyla-tenants-auth-preflight-tests | 0 | 10/10 pass, 0 fail, 0 skipped | 344 ms | `validation/v0.5-dev/logs/hyla-tenants-auth-preflight-tests.log` |
| hyla-site-manager-working-set-tests | 0 | 5/5 pass, 0 fail, 0 skipped | 2363 ms | `validation/v0.5-dev/logs/hyla-site-manager-working-set-tests.log` |
| hyla-postgres-and-matrix-tests | 0 | 25/25 pass, 0 fail, 0 skipped | 1114 ms | `validation/v0.5-dev/logs/hyla-postgres-and-matrix-tests.log` |
| demos | 0 | — | 37369 ms | `validation/v0.5-dev/logs/demos.log` |
| hyla-demo-filesystem | 0 | — | 221 ms | `validation/v0.5-dev/logs/hyla-demo-filesystem.log` |
| benchmarks | 0 | — | 2745 ms | `validation/v0.5-dev/logs/benchmarks.log` |

Totals: 217 tests, 217 passed, 0 failed steps, 0 skipped tests.

## Micro-benchmarks (P01–P04, `validation/v0.5-dev/benchmark-v0.5.json`)

Empty setups, no network; warm cases measure enter + dispose of a sibling Entry with a cached plan template after 50 warmup iterations. Percentiles over individual iterations.

| case | samples | p50 ms | p95 ms | p99 ms | plan-cache entries |
|---|---|---|---|---|---|
| warm-enter-dispose-100-depth-2 | 500 | 0.103 | 0.171 | 0.218 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.081 | 0.146 | 0.174 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.196 | 0.305 | 0.396 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.196 | 0.299 | 0.440 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.155 | 0.248 | 0.348 | 2 |
| bound-entry-private-range-enter-dispose | 500 | 0.014 | 0.019 | 0.028 | 2 |
| override-and-all-request-enter-dispose-100 | 500 | 0.084 | 0.136 | 0.175 | - |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 20.480 ms · warm plan p95 0.424 ms · materialization of a request chain p95 0.068 ms · dispose p95 0.047 ms.

Churn: 10000 request/BoundEntry operations in 866 ms (86.6 µs/op); plan-cache entries max 4; live Envs after 2; heap samples after GC: 6.9 MiB → 7.0 MiB → 7.1 MiB → 7.1 MiB → 7.1 MiB.

### Budgets (`benchmarks/budgets.json`, locked 2026-09-04)

| budget | metric | max | value | result |
|---|---|---|---|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.305 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.299 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.171 | ok |
| churn-10000-requests | planCacheEntriesMax | 8 | 4.000 | ok |
| churn-10000-requests-liveEnvs | liveEnvCountAfter | 2 | 2.000 | ok |
| lru-churn-500-shapes | planCacheEntries | 16 | 16.000 | ok |

### v0.4 comparison on the same machine (P03)

The v0.4.0 baseline archive was rebuilt in a scratch directory and its own benchmark (`benchmarks/v0.4-planning.mjs`) was run unchanged; the same script was then run against the v0.5 core (`benchmarks/results-v0.4-workload-on-v0.5-same-machine.json`). Same workload, same host, same Node:

| case (v0.4 workload) | v0.4 core p95 ms | v0.5 core p95 ms |
|---|---|---|
| request-chain-100-depth-2 | 0.148 | 0.182 |
| request-chain-100-depth-6 | 0.071 | 0.093 |
| request-chain-300-depth-2 | 0.304 | 0.336 |
| request-chain-300-depth-6 | 0.323 | 0.349 |
| selector-request-3-candidates | 0.056 | 0.072 |
| binding-request-2-choices | 0.023 | 0.029 |

v0.5 is within ~15% of v0.4 on the v0.4 workload and well inside the 2 ms budget; the v0.5 representative world (Bindings, `auto`, `C.all`, SCC, BoundEntry, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.

## Working set (H11 / P05, `validation/working-set.json`)

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 502, creations 504, leases 0, pending acquires 0. Heap after GC per phase: start 17.7 MiB (records 0, live envs 2); after-hot 17.8 MiB (records 3, live envs 5); after-rotation 18.8 MiB (records 6, live envs 8); after-tail 18.4 MiB (records 1, live envs 3); after-mixed 18.8 MiB (records 6, live envs 8); after-idle-sweep 18.5 MiB (records 0, live envs 2). Plan cache at the end: {"hits":504,"misses":5,"entries":5,"evictions":0,"maxEntries":512}.

## What is not covered

- Coverage percentages are not a gate in v0.5; the adversarial and application suites are.
- Benchmarks use empty setups; Hyla-mini request latency including PostgreSQL round trips is not a micro-benchmark and is not claimed here.
- Numbers were recorded while other processes (audits) may have been running; the release run is the record of reference.

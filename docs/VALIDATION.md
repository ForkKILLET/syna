# Validation (VALIDATION)

Every number below is copied by a script (`scripts/validation-doc.mjs`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the release run `node scripts/verify-v05.mjs --release` recorded in `validation/v0.5-release/manifest.json` — status **COMPLETE**, generated 2026-09-05T13:29:44.499Z, source fingerprint `1c7128c6cb435de0285ed27ec78c93be9334769cd833966173068866a5ff8a6d` (227 files), git commit `0434be0` (dirty: false).

The shipped source additionally contains this document, so the release run recorded in `RELEASE_MANIFEST.json` / `validation/v0.5-release/` was executed once more on that final source; it is the record of reference for the archive hashes and fingerprint. Its step list and test counts are the same by construction (the gate fails on any deviation); its timings are its own and may differ within noise from the ones quoted here.

## Environment

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL: temporary cluster created by `scripts/pg-test-cluster.mjs` (`postgres://syna@127.0.0.1:54329`, `fsync=off`), removed after each step; server binaries Homebrew `postgresql@17` 17.10 as recorded in `work/v05/STATE.md`
- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile

## Release gate steps (`validation/v0.5-release/manifest.json`)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 156 ms | `validation/v0.5-release/logs/clean.log` |
| build | 0 | — | 1775 ms | `validation/v0.5-release/logs/build.log` |
| type-tests | 0 | — | 552 ms | `validation/v0.5-release/logs/type-tests.log` |
| core-tests | 0 | 154/154 pass, 0 fail, 0 not run | 886 ms | `validation/v0.5-release/logs/core-tests.log` |
| hyla-filesystem-tests | 0 | 47/47 pass, 0 fail, 0 not run | 699 ms | `validation/v0.5-release/logs/hyla-filesystem-tests.log` |
| hyla-render-tests | 0 | 4/4 pass, 0 fail, 0 not run | 238 ms | `validation/v0.5-release/logs/hyla-render-tests.log` |
| hyla-tenants-auth-preflight-tests | 0 | 10/10 pass, 0 fail, 0 not run | 352 ms | `validation/v0.5-release/logs/hyla-tenants-auth-preflight-tests.log` |
| hyla-audit-regression-tests | 0 | 12/12 pass, 0 fail, 0 not run | 3712 ms | `validation/v0.5-release/logs/hyla-audit-regression-tests.log` |
| hyla-review-regression-tests | 0 | 6/6 pass, 0 fail, 0 not run | 1468 ms | `validation/v0.5-release/logs/hyla-review-regression-tests.log` |
| hyla-site-manager-working-set-tests | 0 | 5/5 pass, 0 fail, 0 not run | 2954 ms | `validation/v0.5-release/logs/hyla-site-manager-working-set-tests.log` |
| hyla-postgres-and-matrix-tests | 0 | 27/27 pass, 0 fail, 0 not run | 1326 ms | `validation/v0.5-release/logs/hyla-postgres-and-matrix-tests.log` |
| demos | 0 | — | 37664 ms | `validation/v0.5-release/logs/demos.log` |
| hyla-demo-filesystem | 0 | — | 249 ms | `validation/v0.5-release/logs/hyla-demo-filesystem.log` |
| benchmarks | 0 | — | 3235 ms | `validation/v0.5-release/logs/benchmarks.log` |
| archive-scan | 0 | — | — | `validation/v0.5-release/archive-scan.json` |
| archive-tar | 0 | — | 112 ms | `validation/v0.5-release/logs/archive-tar.log` |
| archive-zip | 0 | — | 27 ms | `validation/v0.5-release/logs/archive-zip.log` |
| rebuild-unpack | 0 | — | 96 ms | `validation/v0.5-release/logs/rebuild-unpack.log` |
| rebuild-install | 0 | — | 545 ms | `validation/v0.5-release/logs/rebuild-install.log` |
| rebuild-build | 0 | — | 2036 ms | `validation/v0.5-release/logs/rebuild-build.log` |
| rebuild-type-tests | 0 | — | 550 ms | `validation/v0.5-release/logs/rebuild-type-tests.log` |
| rebuild-core-tests | 0 | 154/154 pass, 0 fail, 0 not run | 847 ms | `validation/v0.5-release/logs/rebuild-core-tests.log` |
| rebuild-app-tests | 0 | 84/84 pass, 0 fail, 0 not run | 3763 ms | `validation/v0.5-release/logs/rebuild-app-tests.log` |
| rebuild-postgres-matrix-tests | 0 | 27/27 pass, 0 fail, 0 not run | 1186 ms | `validation/v0.5-release/logs/rebuild-postgres-matrix-tests.log` |
| rebuild-demo | 0 | — | 228 ms | `validation/v0.5-release/logs/rebuild-demo.log` |
| pack-core | 0 | — | 226 ms | `validation/v0.5-release/logs/pack-core.log` |
| pack-tsconfig | 0 | — | 168 ms | `validation/v0.5-release/logs/pack-tsconfig.log` |
| consumer-install | 0 | — | 968 ms | `validation/v0.5-release/logs/consumer-install.log` |
| consumer-build | 0 | — | 536 ms | `validation/v0.5-release/logs/consumer-build.log` |
| consumer-run | 0 | — | 162 ms | `validation/v0.5-release/logs/consumer-run.log` |
| consumer-smoke-result | 0 | — | — | `validation/v0.5-release/logs/consumer-run.log` |

Totals: 31 steps, 0 failed steps, 530 tests, 530 passed, 0 skipped/not run. Blocked steps: 0.

The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.

## Release artefacts (`validation/v0.5-release/SHA256SUMS.txt`)

| artefact | bytes | sha256 |
|---|---:|---|
| `work/release/syna-v0.5.0-source.tar.gz` | 395932 | `3222244bff600b28ca63e6e3b1f014904e14b116f1356fad6576587697f125ee` |
| `work/release/syna-v0.5.0-source.zip` | 510343 | `777ca7e75a463081c6bcfafafc45fa08d33776697cf26e1941d12588c9218991` |
| `work/release/pack/syna-core-0.5.0.tgz` | 92481 | `dd6f344a35a43e129f6d7a4123f9f53d8bc3f00d0347a578990aed48baf76a31` |
| `work/release/pack/syna-tsconfig-0.5.0.tgz` | 1483 | `81861252837e4c2c934f8a06380e247086cb1f868c9e8c8f93bc76f7d7725cbf` |

Rebuilt from `work/release/syna-v0.5.0-source.tar.gz`. Consumer smoke result (last line of `validation/v0.5-release/logs/consumer-run.log`): `{"result":42,"revision":"7.3.1","explainOk":true}`.

## Micro-benchmarks (P01–P04, `validation/v0.5-release/benchmark-v0.5.json`)

Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions. Warmup iterations: 50. Quick mode: false.

| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |
|---|---:|---:|---:|---:|---|---:|
| warm-enter-dispose-100-depth-2 | 500 | 0.109 | 0.183 | 0.229 | 100 / 20 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.098 | 0.162 | 0.197 | 100 / 20 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.248 | 0.370 | 0.442 | 260 / 60 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.246 | 0.357 | 0.408 | 260 / 60 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.185 | 0.269 | 0.401 | 140 / — | 2 |
| bound-entry-private-range-request-enter-dispose-100 | 500 | 0.118 | 0.172 | 0.204 | 102 / 20 | 4 |
| override-and-all-request-enter-dispose-100 | 500 | 0.110 | 0.150 | 0.197 | — | — |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 21.625 ms · warm plan p95 0.490 ms · materialization of a request chain p95 0.071 ms · dispose p95 0.121 ms.

Churn: 10000 request/BoundEntry operations in 1147 ms (114.7 µs/op); plan-cache entries max 4 (hits 9998, misses 4); live Envs after 2; heap after GC: 6.8 MiB → 7.0 MiB → 7.1 MiB → 7.1 MiB → 7.1 MiB.

LRU: 500 distinct Entry shapes → 16 cached templates (max 16, evictions 484).

### Budgets (`benchmarks/budgets.json`) — all ok: true

| budget | metric | max | value | result |
|---|---|---:|---:|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.370 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.357 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.183 | ok |
| bound-entry-private-range-request-enter-dispose-100 | p95Ms | 1 | 0.172 | ok |
| churn-10000-requests | planCacheEntriesMax | 8 | 4.000 | ok |
| churn-10000-requests-liveEnvs | liveEnvCountAfter | 2 | 2.000 | ok |
| lru-churn-500-shapes | planCacheEntries | 16 | 16.000 | ok |

### v0.4 comparison on the same machine (P03)

The v0.4.0 baseline archive (sha256 `e0f21a94765aeb9f8e9e7987d596844e4d1bf56fce3584c8de1358131f42a96c`) was rebuilt in a scratch directory and its own benchmark (`benchmarks/v0.4-planning.mjs`) was run unchanged (`benchmarks/results-v0.4.0-baseline-same-machine.json`); the same script was then run against the v0.5 core (`benchmarks/results-v0.4-workload-on-v0.5-same-machine.json`). Same workload, same host, same Node:

| case (v0.4 workload) | v0.4 core p95 ms | v0.5 core p95 ms | delta |
|---|---:|---:|---:|
| request-chain-100-depth-2 | 0.148 | 0.182 | +22 % |
| request-chain-100-depth-6 | 0.071 | 0.093 | +31 % |
| request-chain-300-depth-2 | 0.304 | 0.336 | +11 % |
| request-chain-300-depth-6 | 0.323 | 0.349 | +8 % |
| selector-request-3-candidates | 0.056 | 0.072 | +28 % |
| binding-request-2-choices | 0.023 | 0.029 | +23 % |

On the v0.4 workload the v0.5 core is slower by +8 % to +31 % at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, `auto`, `C.all`, SCC, BoundEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.

## Working set (H11 / P05, `validation/v0.5-release/working-set.json`)

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 490, creations 492, creation failures 0, leases 0, pending acquires 0. Heap after GC per phase: start 17.1 MiB (records 0, live envs 2); after-hot 17.8 MiB (records 3, live envs 5); after-rotation 18.8 MiB (records 6, live envs 8); after-tail 18.6 MiB (records 1, live envs 3); after-mixed 19.3 MiB (records 6, live envs 8); after-idle-sweep 18.6 MiB (records 0, live envs 2). Plan cache at the end: {"hits":492,"misses":5,"entries":5,"evictions":0,"maxEntries":512}.

## Audit and review fixes covered by this run

The suites above include the regressions written for the independent audits and for the second review round (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests`, `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, and the two repository-conformance cases (content version, domain claims) inside the filesystem and PostgreSQL suites.

## What is not covered

- Coverage percentages are not a gate in v0.5; the adversarial and application suites are.
- Benchmarks use empty setups; Hyla-mini request latency including PostgreSQL round trips is not a micro-benchmark and is not claimed here.
- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).

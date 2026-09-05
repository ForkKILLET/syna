# Validation (VALIDATION)

Every number below is copied by a script (`scripts/validation-doc.mjs`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the release run `node scripts/verify-v05.mjs --release` recorded in `validation/v0.5-release/manifest.json` — status **COMPLETE**, generated 2026-09-05T13:31:35.854Z, source fingerprint `c8e66c9e79d1e4e806043e9a54c65b48be858de3711cb436f75517b084443fb3` (227 files), git commit `f327c9c` (dirty: false).

The shipped source additionally contains this document, so the release run recorded in `RELEASE_MANIFEST.json` / `validation/v0.5-release/` was executed once more on that final source; it is the record of reference for the archive hashes and fingerprint. Its step list and test counts are the same by construction (the gate fails on any deviation); its timings are its own and may differ within noise from the ones quoted here.

## Environment

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL: temporary cluster created by `scripts/pg-test-cluster.mjs` (`postgres://syna@127.0.0.1:54329`, `fsync=off`), removed after each step; server binaries Homebrew `postgresql@17` 17.10 as recorded in `work/v05/STATE.md`
- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile

## Release gate steps (`validation/v0.5-release/manifest.json`)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 167 ms | `validation/v0.5-release/logs/clean.log` |
| build | 0 | — | 1813 ms | `validation/v0.5-release/logs/build.log` |
| type-tests | 0 | — | 586 ms | `validation/v0.5-release/logs/type-tests.log` |
| core-tests | 0 | 154/154 pass, 0 fail, 0 not run | 862 ms | `validation/v0.5-release/logs/core-tests.log` |
| hyla-filesystem-tests | 0 | 47/47 pass, 0 fail, 0 not run | 704 ms | `validation/v0.5-release/logs/hyla-filesystem-tests.log` |
| hyla-render-tests | 0 | 4/4 pass, 0 fail, 0 not run | 246 ms | `validation/v0.5-release/logs/hyla-render-tests.log` |
| hyla-tenants-auth-preflight-tests | 0 | 10/10 pass, 0 fail, 0 not run | 357 ms | `validation/v0.5-release/logs/hyla-tenants-auth-preflight-tests.log` |
| hyla-audit-regression-tests | 0 | 12/12 pass, 0 fail, 0 not run | 3695 ms | `validation/v0.5-release/logs/hyla-audit-regression-tests.log` |
| hyla-review-regression-tests | 0 | 6/6 pass, 0 fail, 0 not run | 1469 ms | `validation/v0.5-release/logs/hyla-review-regression-tests.log` |
| hyla-site-manager-working-set-tests | 0 | 5/5 pass, 0 fail, 0 not run | 3593 ms | `validation/v0.5-release/logs/hyla-site-manager-working-set-tests.log` |
| hyla-postgres-and-matrix-tests | 0 | 27/27 pass, 0 fail, 0 not run | 1178 ms | `validation/v0.5-release/logs/hyla-postgres-and-matrix-tests.log` |
| demos | 0 | — | 37627 ms | `validation/v0.5-release/logs/demos.log` |
| hyla-demo-filesystem | 0 | — | 312 ms | `validation/v0.5-release/logs/hyla-demo-filesystem.log` |
| benchmarks | 0 | — | 3329 ms | `validation/v0.5-release/logs/benchmarks.log` |
| archive-scan | 0 | — | — | `validation/v0.5-release/archive-scan.json` |
| archive-tar | 0 | — | 110 ms | `validation/v0.5-release/logs/archive-tar.log` |
| archive-zip | 0 | — | 26 ms | `validation/v0.5-release/logs/archive-zip.log` |
| rebuild-unpack | 0 | — | 92 ms | `validation/v0.5-release/logs/rebuild-unpack.log` |
| rebuild-install | 0 | — | 540 ms | `validation/v0.5-release/logs/rebuild-install.log` |
| rebuild-build | 0 | — | 2361 ms | `validation/v0.5-release/logs/rebuild-build.log` |
| rebuild-type-tests | 0 | — | 552 ms | `validation/v0.5-release/logs/rebuild-type-tests.log` |
| rebuild-core-tests | 0 | 154/154 pass, 0 fail, 0 not run | 855 ms | `validation/v0.5-release/logs/rebuild-core-tests.log` |
| rebuild-app-tests | 0 | 84/84 pass, 0 fail, 0 not run | 3780 ms | `validation/v0.5-release/logs/rebuild-app-tests.log` |
| rebuild-postgres-matrix-tests | 0 | 27/27 pass, 0 fail, 0 not run | 1193 ms | `validation/v0.5-release/logs/rebuild-postgres-matrix-tests.log` |
| rebuild-demo | 0 | — | 228 ms | `validation/v0.5-release/logs/rebuild-demo.log` |
| pack-core | 0 | — | 233 ms | `validation/v0.5-release/logs/pack-core.log` |
| pack-tsconfig | 0 | — | 167 ms | `validation/v0.5-release/logs/pack-tsconfig.log` |
| consumer-install | 0 | — | 356 ms | `validation/v0.5-release/logs/consumer-install.log` |
| consumer-build | 0 | — | 621 ms | `validation/v0.5-release/logs/consumer-build.log` |
| consumer-run | 0 | — | 159 ms | `validation/v0.5-release/logs/consumer-run.log` |
| consumer-smoke-result | 0 | — | — | `validation/v0.5-release/logs/consumer-run.log` |

Totals: 31 steps, 0 failed steps; 530 test executions: 265 distinct cases, 265 of them executed a second time in the rebuilt copy (the `rebuild-*` steps); 530 passed, 0 skipped/not run. Blocked steps: 0.

The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.

## Release artefacts

The 2 source archives and 2 npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's `SHA256SUMS.txt` and under `release` in its `manifest.json`. They are not copied here: this page is part of the shipped source, so the run of reference (`RELEASE_MANIFEST.json`, `validation/v0.5-release/SHA256SUMS.txt`) is executed on a source that already contains it and its hashes are the ones to check. Rebuilt from `work/release/syna-v0.5.0-source.tar.gz`. Consumer smoke result (last line of `validation/v0.5-release/logs/consumer-run.log`): `{"result":42,"revision":"7.3.1","explainOk":true}`.

## Micro-benchmarks (P01–P04, `validation/v0.5-release/benchmark-v0.5.json`)

Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions. Warmup iterations: 50. Quick mode: false.

| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |
|---|---:|---:|---:|---:|---|---:|
| warm-enter-dispose-100-depth-2 | 500 | 0.111 | 0.175 | 0.219 | 100 / 20 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.098 | 0.159 | 0.202 | 100 / 20 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.250 | 0.369 | 0.477 | 260 / 60 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.245 | 0.368 | 0.442 | 260 / 60 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.193 | 0.286 | 0.377 | 140 / — | 2 |
| bound-entry-private-range-request-enter-dispose-100 | 500 | 0.127 | 0.191 | 0.320 | 102 / 20 | 4 |
| override-and-all-request-enter-dispose-100 | 500 | 0.116 | 0.164 | 0.316 | — | — |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 21.507 ms · warm plan p95 0.505 ms · materialization of a request chain p95 0.067 ms · dispose p95 0.145 ms.

Churn: 10000 request/BoundEntry operations in 1196 ms (119.6 µs/op); plan-cache entries max 4 (hits 9998, misses 4); live Envs after 2; heap after GC: 6.8 MiB → 7.0 MiB → 7.1 MiB → 7.1 MiB → 7.1 MiB.

LRU: 500 distinct Entry shapes → 16 cached templates (max 16, evictions 484).

### Budgets (`benchmarks/budgets.json`) — all ok: true

| budget | metric | max | value | result |
|---|---|---:|---:|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.369 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.368 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.175 | ok |
| bound-entry-private-range-request-enter-dispose-100 | p95Ms | 1 | 0.191 | ok |
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

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 502, creations 504, creation failures 0, leases 0, pending acquires 0. Heap after GC per phase: start 17.9 MiB (records 0, live envs 2, disposing 0); after-hot 17.8 MiB (records 3, live envs 5, disposing 0); after-rotation 18.9 MiB (records 6, live envs 8, disposing 0); after-tail 18.6 MiB (records 1, live envs 3, disposing 0); after-mixed 19.2 MiB (records 6, live envs 8, disposing 0); after-idle-sweep 18.8 MiB (records 0, live envs 2, disposing 0). Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most n/a of capacity 6. Plan cache at the end: {"hits":504,"misses":5,"entries":5,"evictions":0,"maxEntries":512}.

## Audit and review fixes covered by this run

The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests` (the third round's core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting (`demo: OK` and three `: 200` cells are required, not just exit 0).

## What is not covered

- Coverage percentages are not a gate in v0.5; the adversarial and application suites are.
- Benchmarks use empty setups; Hyla-mini request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.
- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).

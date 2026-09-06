# Validation (VALIDATION)

Every number below is copied by a script (`scripts/validation-doc.mjs`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the release run `node scripts/verify-v07.mjs --release` recorded in `validation/v0.7-release/manifest.json` — status **COMPLETE**, generated 2026-09-06T19:05:13.409Z, source fingerprint `b60ba6744a98ffdc8c0dc5690309382f8dd15dd4e634e751a408c97e4d7f569b` (340 files), git commit `78d611a` (tracked files unchanged; untracked files present: SYNA_V06_API_EXECUTION_PROMPT.md, SYNA_V06_GOAL.txt, SYNA_V07_EXECUTION_PROMPT.md, SYNA_V07_GOAL.txt).

The shipped source additionally contains this document, so the release run recorded in `RELEASE_MANIFEST.json` / `validation/v0.7-release/` was executed once more on that final source; it is the record of reference for the archive hashes and fingerprint. The gate does not compare runs with each other and fails none for differing from another: the same steps run, and each manifest records under `previousRun` whether its step list and per-step test counts equal those of the run it replaced (for the final run, the run quoted here); its timings are its own and may differ within noise.

## Environment

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL: PostgreSQL 17.10 at `postgres://syna@127.0.0.1:54329/postgres` (temporary cluster), as printed by `scripts/pg-test-cluster.mjs` in the step log and copied into the manifest; the temporary cluster runs with `fsync=off` and is created before and removed after each PostgreSQL step
- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile

## Release gate steps (`validation/v0.7-release/manifest.json`)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 136 ms | `validation/v0.7-release/logs/clean.log` |
| build | 0 | — | 7862 ms | `validation/v0.7-release/logs/build.log` |
| type-tests | 0 | — | 3519 ms | `validation/v0.7-release/logs/type-tests.log` |
| core-tests | 0 | 233/233 pass, 0 fail, 0 not run | 2723 ms | `validation/v0.7-release/logs/core-tests.log` |
| hyla-filesystem-tests | 0 | 69/69 pass, 0 fail, 0 not run | 924 ms | `validation/v0.7-release/logs/hyla-filesystem-tests.log` |
| hyla-render-tests | 0 | 8/8 pass, 0 fail, 0 not run | 291 ms | `validation/v0.7-release/logs/hyla-render-tests.log` |
| hyla-v06-compat-tests | 0 | 3/3 pass, 0 fail, 0 not run | 186 ms | `validation/v0.7-release/logs/hyla-v06-compat-tests.log` |
| hyla-tenants-auth-preflight-tests | 0 | 12/12 pass, 0 fail, 0 not run | 398 ms | `validation/v0.7-release/logs/hyla-tenants-auth-preflight-tests.log` |
| hyla-audit-regression-tests | 0 | 22/22 pass, 0 fail, 0 not run | 5325 ms | `validation/v0.7-release/logs/hyla-audit-regression-tests.log` |
| hyla-review-regression-tests | 0 | 8/8 pass, 0 fail, 0 not run | 1557 ms | `validation/v0.7-release/logs/hyla-review-regression-tests.log` |
| hyla-site-manager-working-set-tests | 0 | 14/14 pass, 0 fail, 0 not run | 5206 ms | `validation/v0.7-release/logs/hyla-site-manager-working-set-tests.log` |
| hyla-postgres-and-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2358 ms | `validation/v0.7-release/logs/hyla-postgres-and-matrix-tests.log` |
| gate-self-tests | 0 | 21/21 pass, 0 fail, 0 not run | 3721 ms | `validation/v0.7-release/logs/gate-self-tests.log` |
| api-inventory | 0 | — | 3485 ms | `validation/v0.7-release/logs/api-inventory.log` |
| api-inventory-no-deprecated | 0 | — | — | `validation/v0.7-release/api-inventory.json` |
| api-inventory-diff | 0 | — | 154 ms | `validation/v0.7-release/logs/api-inventory-diff.log` |
| any-count | 0 | — | 214 ms | `validation/v0.7-release/logs/any-count.log` |
| demos | 0 | — | 32824 ms | `validation/v0.7-release/logs/demos.log` |
| hyla-demo-filesystem | 0 | — | 250 ms | `validation/v0.7-release/logs/hyla-demo-filesystem.log` |
| benchmarks | 0 | — | 3416 ms | `validation/v0.7-release/logs/benchmarks.log` |
| benchmark-compare | 0 | — | 153668 ms | `validation/v0.7-release/logs/benchmark-compare.log` |
| hyla-request-latency | 0 | — | 1845 ms | `validation/v0.7-release/logs/hyla-request-latency.log` |
| archive-scan | 0 | — | — | `validation/v0.7-release/archive-scan.json` |
| archive-tar | 0 | — | 180 ms | `validation/v0.7-release/logs/archive-tar.log` |
| archive-zip | 0 | — | 54 ms | `validation/v0.7-release/logs/archive-zip.log` |
| rebuild-unpack | 0 | — | 133 ms | `validation/v0.7-release/logs/rebuild-unpack.log` |
| rebuild-install | 0 | — | 431 ms | `validation/v0.7-release/logs/rebuild-install.log` |
| rebuild-build | 0 | — | 8377 ms | `validation/v0.7-release/logs/rebuild-build.log` |
| rebuild-type-tests | 0 | — | 3469 ms | `validation/v0.7-release/logs/rebuild-type-tests.log` |
| rebuild-core-tests | 0 | 233/233 pass, 0 fail, 0 not run | 2742 ms | `validation/v0.7-release/logs/rebuild-core-tests.log` |
| rebuild-app-tests | 0 | 136/136 pass, 0 fail, 0 not run | 5397 ms | `validation/v0.7-release/logs/rebuild-app-tests.log` |
| rebuild-postgres-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2325 ms | `validation/v0.7-release/logs/rebuild-postgres-matrix-tests.log` |
| rebuild-gate-self-tests | 0 | 21/21 pass, 0 fail, 0 not run | 3758 ms | `validation/v0.7-release/logs/rebuild-gate-self-tests.log` |
| rebuild-demo | 0 | — | 253 ms | `validation/v0.7-release/logs/rebuild-demo.log` |
| pack-core | 0 | — | 238 ms | `validation/v0.7-release/logs/pack-core.log` |
| pack-tsconfig | 0 | — | 168 ms | `validation/v0.7-release/logs/pack-tsconfig.log` |
| consumer-install | 0 | — | 1311 ms | `validation/v0.7-release/logs/consumer-install.log` |
| consumer-build | 0 | — | 588 ms | `validation/v0.7-release/logs/consumer-build.log` |
| consumer-run | 0 | — | 176 ms | `validation/v0.7-release/logs/consumer-run.log` |
| consumer-smoke-result | 0 | — | — | `validation/v0.7-release/logs/consumer-run.log` |

Totals: 40 steps, 0 failed steps; 870 test executions: 435 distinct cases, 435 of them executed a second time in the rebuilt copy (the `rebuild-*` steps); 870 passed, 0 skipped/not run. Blocked steps: 0.

The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.

## Release artefacts

The 2 source archives and 2 npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's `SHA256SUMS.txt` and under `release` in its `manifest.json`. They are not copied here: this page is part of the shipped source, so the run of reference (`RELEASE_MANIFEST.json`, `validation/v0.7-release/SHA256SUMS.txt`) is executed on a source that already contains it and its hashes are the ones to check. Rebuilt from `work/release/syna-v0.7.0-source.tar.gz`. Consumer smoke result (last line of `validation/v0.7-release/logs/consumer-run.log`): `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0}`.

## Micro-benchmarks (P01–P04, `validation/v0.7-release/benchmark-v0.5.json`)

Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions. Warmup iterations: 50. Quick mode: false.

| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |
|---|---:|---:|---:|---:|---|---:|
| warm-enter-dispose-100-depth-2 | 500 | 0.115 | 0.190 | 0.236 | 100 / 20 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.107 | 0.165 | 0.196 | 100 / 20 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.258 | 0.383 | 0.425 | 260 / 60 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.258 | 0.381 | 0.432 | 260 / 60 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.204 | 0.309 | 0.387 | 140 / — | 2 |
| bound-entry-private-range-request-enter-dispose-100 | 500 | 0.119 | 0.178 | 0.216 | 101 / 21 | 4 |
| override-and-all-request-enter-dispose-100 | 500 | 0.120 | 0.166 | 0.197 | — | — |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 22.311 ms · warm plan p95 0.464 ms · materialization of a request chain p95 0.073 ms · dispose p95 0.123 ms.

Churn: 10000 request/AnchoredEntry operations in 1221 ms (122.1 µs/op); plan-cache entries max 4 (hits 9998, misses 4); live Envs after 2; heap after GC: 7.0 MiB → 7.2 MiB → 7.3 MiB → 7.3 MiB → 7.3 MiB.

LRU: 500 distinct Entry shapes → 16 cached templates (max 16, evictions 484).

### Budgets (`benchmarks/budgets.json`) — all ok: true

| budget | metric | max | value | result |
|---|---|---:|---:|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.383 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.381 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.190 | ok |
| bound-entry-private-range-request-enter-dispose-100 | p95Ms | 1 | 0.178 | ok |
| churn-10000-requests | planCacheEntriesMax | 8 | 4.000 | ok |
| churn-10000-requests-liveEnvs | liveEnvCountAfter | 2 | 2.000 | ok |
| lru-churn-500-shapes | planCacheEntries | 16 | 16.000 | ok |

### 0.6.0 comparison on the same machine (`validation/v0.7-release/benchmark-compare/same-session.json`)

`scripts/benchmark-same-session.mjs` ran `benchmarks/v0.5-planning.mjs` 21 times on this host, took the element-wise median and compared it with the 0.6.0 source (commit `582c93a`) exported from git into a scratch directory, installed from its lockfile, built and benchmarked 21 times in the same session (`scripts/benchmark-same-session.mjs`: one discarded warm-up run per side, then 21 rounds that benchmark both sides in alternating order; medians in `validation/v0.7-release/benchmark-compare/`): environment identical (platform darwin, arch arm64, cpu Apple M4 Pro, cpuCount 14, node (major) v26); 23/23 p50/p95/per-operation values within ±10 %; 116/116 plan-cache counters and shape counts equal; overall OK.

Machine-state drift (informational): this session's 0.6.0 against the file recorded on 2026-09-06T08:53:10.713Z (`benchmarks/results-v0.6.0-baseline-same-machine.json`) has 23/23 timings within ±10 % — the same code measured at two moments, which is why both sides are measured in one session.

| value | baseline (0.6.0) | this source (0.7.0) | delta |
|---|---:|---:|---:|
| cases.warm-enter-dispose-100-depth-2.timing.p50Ms | 0.113 | 0.114 | +0.4 % |
| cases.warm-enter-dispose-100-depth-2.timing.p95Ms | 0.186 | 0.188 | +1.1 % |
| cases.warm-enter-dispose-100-depth-6.timing.p50Ms | 0.108 | 0.108 | +0.1 % |
| cases.warm-enter-dispose-100-depth-6.timing.p95Ms | 0.170 | 0.171 | +0.4 % |
| cases.warm-enter-dispose-300-depth-2.timing.p50Ms | 0.258 | 0.259 | +0.2 % |
| cases.warm-enter-dispose-300-depth-2.timing.p95Ms | 0.387 | 0.384 | -0.8 % |
| cases.warm-enter-dispose-300-depth-6.timing.p50Ms | 0.255 | 0.256 | +0.3 % |
| cases.warm-enter-dispose-300-depth-6.timing.p95Ms | 0.378 | 0.382 | +0.9 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p50Ms | 20.149 | 20.186 | +0.2 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p95Ms | 22.534 | 22.538 | +0.0 % |
| cases.phase-breakdown-300.warmPlanMs.p50Ms | 0.364 | 0.372 | +2.1 % |
| cases.phase-breakdown-300.warmPlanMs.p95Ms | 0.495 | 0.501 | +1.2 % |
| cases.phase-breakdown-300.materializationMs.p50Ms | 0.028 | 0.025 | -7.4 % |
| cases.phase-breakdown-300.materializationMs.p95Ms | 0.060 | 0.058 | -3.0 % |
| cases.phase-breakdown-300.disposeMs.p50Ms | 0.095 | 0.095 | +0.6 % |
| cases.phase-breakdown-300.disposeMs.p95Ms | 0.119 | 0.122 | +1.8 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p50Ms | 0.186 | 0.186 | +0.5 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p95Ms | 0.213 | 0.214 | +0.7 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p50Ms | 0.122 | 0.123 | +0.8 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p95Ms | 0.168 | 0.180 | +7.2 % |
| cases.override-and-all-request-enter-dispose-100.timing.p50Ms | 0.120 | 0.120 | -0.3 % |
| cases.override-and-all-request-enter-dispose-100.timing.p95Ms | 0.176 | 0.172 | -2.3 % |
| cases.churn-10000-requests.perOperationMs | 0.122 | 0.123 | +1.3 % |

Every one of the 116 plan-cache counters (hits, misses, entries, evictions) and shape counts is equal to the baseline.

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

On the v0.4 workload the v0.5 core is slower by +8 % to +31 % at p95 (all cases stay far inside the 2 ms budget). The v0.5 representative world (Bindings, `auto`, `C.all`, SCC, AnchoredEntry private realm, Input closures) is heavier than the v0.4 request chain and is reported separately above. These values are targets for this machine, not cross-machine guarantees.

## Working set (H11 / P05, `validation/v0.7-release/working-set.json`)

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 480, creations 481, creation failures 0, leases 0, pending acquires 0. Heap after GC per phase: start 18.9 MiB (records 0, live envs 2, disposing 0); after-hot 20.0 MiB (records 3, live envs 5, disposing 0); after-rotation 20.2 MiB (records 6, live envs 8, disposing 0); after-tail 20.0 MiB (records 5, live envs 7, disposing 0); after-mixed 20.3 MiB (records 6, live envs 8, disposing 0); after-idle-sweep 19.9 MiB (records 0, live envs 2, disposing 0). Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most 6 of capacity 6. Plan cache at the end: {"hits":482,"misses":6,"entries":6,"evictions":0,"maxEntries":512}.

## Hyla-mini request latency (report only, `validation/v0.7-release/hyla-request-latency.json`)

Full HTTP round trips on 127.0.0.1 measured from a node:http client in the same process; not a budget and not a cross-machine claim. Quick mode: false. Not a budget: nothing here gates the release.

| backend | case | samples | p50 ms | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|
| filesystem | post-page-cached | 200 | 1.218 | 1.777 | 2.587 |
| filesystem | index-cached | 200 | 0.453 | 0.542 | 0.642 |
| filesystem | comment-preview-untrusted | 200 | 0.462 | 0.634 | 0.755 |
| filesystem | post-page-cold-site | 50 | 1.360 | 1.532 | 1.912 |
| postgres | post-page-cached | 200 | 0.552 | 1.024 | 1.663 |
| postgres | index-cached | 200 | 0.324 | 0.404 | 0.466 |
| postgres | comment-preview-untrusted | 200 | 0.356 | 0.463 | 0.551 |
| postgres | post-page-cold-site | 50 | 0.690 | 0.861 | 0.928 |

`post-page-cached`: GET /posts/shared-slug on a warm SiteEnv (page cache hit; still one content-version read per request). `index-cached`: GET / on a warm SiteEnv (page cache hit). `comment-preview-untrusted`: GET /comments/preview?text=… (untrusted pipeline, never cached). `post-page-cold-site`: GET /posts/shared-slug after invalidate(): SiteEnv creation (configuration read, Env, authenticator, context) plus a page-cache miss.

## Audit and review fixes covered by this run

The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests` (the third round's core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting: the Hyla-mini demo must print `demo: OK` and three `: 200` cells, and the `demos` step must print `demo: OK` once per core demo (each checks its own results); exit 0 alone is not enough. The `gate-self-tests` step covers the gate's own tooling (step process groups, cluster script signal forwarding).

## v0.7 evidence in this run

The 0.7 claims rest on steps of this run. Planning layer unchanged: `core-tests` includes `v06-snapshots.test.mjs` (the check/explain/inspect/catalog/error snapshots recorded on 0.5.0, identical apart from the registered renames and the two registered additions) and `reference-planner.test.mjs` (brute-force planner differential). Deletions, diagnostics and the two semantic revisions: the `v07-*` suites in `core-tests` — `v07-expired-forms` and `v07-legacy-implementation-key` (the 23 removed aliases refused, the serialized key read permanently), `v07-s6-reuse-errors`, `v07-s7-env-state`, `v07-s7-invalid-descriptor`, `v07-s8-missing-implementation`, `v07-s10-as-syna-error` (every throw site of the split and tightened codes, `details` asserted key by key), `v07-s1-waiter-deadline` and `v07-s2-state-and-ledger` (the counter-examples of S1 and S2; no state assertion depends on `--expose-gc`) — and `hyla-review-regression-tests` for the application's close report. `gate-self-tests` (21/21 pass) includes the empty deprecation register, the no-old-names scan of every application, benchmark, script, workflow and test suite for the deleted names and the removed error codes, the README example compiled and run as printed, the public-API inventory assertions (exactly the registered removals and additions against the 0.6.0 record) and the `any` budget; `api-inventory` (exit 0), `api-inventory-no-deprecated` (ok: 367 items, 0 @deprecated) and `api-inventory-diff` (exit 0) record the public API of this source, assert that no item of it is deprecated and diff it against the 0.6.0 record; `any-count` (exit 0) checks every file against `scripts/any-baseline-v0.6.0.json`; `benchmark-compare` (exit 0) is the same-machine comparison with 0.6.0 above.

## What is not covered

- Coverage percentages are not a gate in v0.7; the adversarial and application suites are.
- Benchmarks use empty setups; Hyla-mini request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.
- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).

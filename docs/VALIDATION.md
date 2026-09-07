# Validation (VALIDATION)

Every number below is copied by a script (`scripts/validation-doc.mjs`) from machine-readable results of the transparent orchestrator; nothing is hand-typed. Source of this page: the release run `node scripts/verify-release.mjs --release` recorded in `validation/v1.0.0-rc.1-release/manifest.json` — status **COMPLETE**, generated 2026-09-07T05:25:05.827Z, source fingerprint `e90606c5432d235146db6306d7cab3cca66712ae040a1eebfebade0e7520b2ae` (353 files), git commit `77d6440` (clean checkout).

This document is generated from that run's manifest after the run and committed with the run's evidence (`RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.1-release/`) in the release commit; from 1.0.0-rc.1 on the gate neither fingerprints nor archives it, so the source fingerprint and the archive hashes the manifest records hold on the commit that carries them, and one run is the record of reference. The gate does not compare runs with each other and fails none for differing from another: the same steps run, and each manifest records under `previousRun` whether its step list and per-step test counts equal those of the run it replaced; its timings are its own and may differ within noise.

## Environment

- Host: darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB
- Node v26.0.0 (V8 14.6.202.33-node.19), `--expose-gc` for benchmarks and working-set tests
- PostgreSQL: PostgreSQL 17.10 at `postgres://syna@127.0.0.1:54329/postgres` (temporary cluster), as printed by `scripts/pg-test-cluster.mjs` in the step log and copied into the manifest; the temporary cluster runs with `fsync=off` and is created before and removed after each PostgreSQL step
- Package manager: npm workspaces (`npm ci` in the rebuild); TypeScript 5.9.x from the lockfile

## Release gate steps (`validation/v1.0.0-rc.1-release/manifest.json`)

| step | exit | tests | duration | log |
|---|---|---|---|---|
| clean | 0 | — | 147 ms | `validation/v1.0.0-rc.1-release/logs/clean.log` |
| build | 0 | — | 8035 ms | `validation/v1.0.0-rc.1-release/logs/build.log` |
| type-tests | 0 | — | 3587 ms | `validation/v1.0.0-rc.1-release/logs/type-tests.log` |
| core-tests | 0 | 243/243 pass, 0 fail, 0 not run | 2733 ms | `validation/v1.0.0-rc.1-release/logs/core-tests.log` |
| hyla-filesystem-tests | 0 | 69/69 pass, 0 fail, 0 not run | 1008 ms | `validation/v1.0.0-rc.1-release/logs/hyla-filesystem-tests.log` |
| hyla-render-tests | 0 | 8/8 pass, 0 fail, 0 not run | 289 ms | `validation/v1.0.0-rc.1-release/logs/hyla-render-tests.log` |
| hyla-tenants-auth-preflight-tests | 0 | 12/12 pass, 0 fail, 0 not run | 463 ms | `validation/v1.0.0-rc.1-release/logs/hyla-tenants-auth-preflight-tests.log` |
| hyla-audit-regression-tests | 0 | 22/22 pass, 0 fail, 0 not run | 5394 ms | `validation/v1.0.0-rc.1-release/logs/hyla-audit-regression-tests.log` |
| hyla-review-regression-tests | 0 | 8/8 pass, 0 fail, 0 not run | 1598 ms | `validation/v1.0.0-rc.1-release/logs/hyla-review-regression-tests.log` |
| hyla-site-manager-working-set-tests | 0 | 14/14 pass, 0 fail, 0 not run | 5293 ms | `validation/v1.0.0-rc.1-release/logs/hyla-site-manager-working-set-tests.log` |
| hyla-postgres-and-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2499 ms | `validation/v1.0.0-rc.1-release/logs/hyla-postgres-and-matrix-tests.log` |
| gate-self-tests | 0 | 26/26 pass, 0 fail, 0 not run | 4090 ms | `validation/v1.0.0-rc.1-release/logs/gate-self-tests.log` |
| api-inventory | 0 | — | 3516 ms | `validation/v1.0.0-rc.1-release/logs/api-inventory.log` |
| api-inventory-no-deprecated | 0 | — | — | `validation/v1.0.0-rc.1-release/api-inventory.json` |
| api-inventory-diff | 0 | — | 159 ms | `validation/v1.0.0-rc.1-release/logs/api-inventory-diff.log` |
| api-inventory-frozen | 0 | — | — | `validation/v1.0.0-rc.1-release/api-inventory-diff.md` |
| codemod-idempotent | 0 | — | 773 ms | `validation/v1.0.0-rc.1-release/logs/codemod-idempotent.log` |
| no-old-reference-tokens | 0 | — | — | `validation/v1.0.0-rc.1-release/old-reference-tokens.json` |
| any-count | 0 | — | 226 ms | `validation/v1.0.0-rc.1-release/logs/any-count.log` |
| demos | 0 | — | 33055 ms | `validation/v1.0.0-rc.1-release/logs/demos.log` |
| hyla-demo-filesystem | 0 | — | 259 ms | `validation/v1.0.0-rc.1-release/logs/hyla-demo-filesystem.log` |
| benchmarks | 0 | — | 3491 ms | `validation/v1.0.0-rc.1-release/logs/benchmarks.log` |
| benchmark-compare | 0 | — | 156477 ms | `validation/v1.0.0-rc.1-release/logs/benchmark-compare.log` |
| hyla-request-latency | 0 | — | 1885 ms | `validation/v1.0.0-rc.1-release/logs/hyla-request-latency.log` |
| archive-scan | 0 | — | — | `validation/v1.0.0-rc.1-release/archive-scan.json` |
| archive-tar | 0 | — | 217 ms | `validation/v1.0.0-rc.1-release/logs/archive-tar.log` |
| archive-zip | 0 | — | 58 ms | `validation/v1.0.0-rc.1-release/logs/archive-zip.log` |
| rebuild-unpack | 0 | — | 133 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-unpack.log` |
| rebuild-install | 0 | — | 430 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-install.log` |
| rebuild-build | 0 | — | 8201 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-build.log` |
| rebuild-type-tests | 0 | — | 3585 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-type-tests.log` |
| rebuild-core-tests | 0 | 243/243 pass, 0 fail, 0 not run | 2738 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-core-tests.log` |
| rebuild-app-tests | 0 | 133/133 pass, 0 fail, 0 not run | 5431 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-app-tests.log` |
| rebuild-postgres-matrix-tests | 0 | 45/45 pass, 0 fail, 0 not run | 2414 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-postgres-matrix-tests.log` |
| rebuild-gate-self-tests | 0 | 26/26 pass, 0 fail, 0 not run | 4044 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-gate-self-tests.log` |
| rebuild-codemod-idempotent | 0 | — | 776 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-codemod-idempotent.log` |
| rebuild-demo | 0 | — | 258 ms | `validation/v1.0.0-rc.1-release/logs/rebuild-demo.log` |
| pack-core | 0 | — | 241 ms | `validation/v1.0.0-rc.1-release/logs/pack-core.log` |
| pack-tsconfig | 0 | — | 174 ms | `validation/v1.0.0-rc.1-release/logs/pack-tsconfig.log` |
| consumer-install | 0 | — | 711 ms | `validation/v1.0.0-rc.1-release/logs/consumer-install.log` |
| consumer-build | 0 | — | 538 ms | `validation/v1.0.0-rc.1-release/logs/consumer-build.log` |
| consumer-run | 0 | — | 175 ms | `validation/v1.0.0-rc.1-release/logs/consumer-run.log` |
| consumer-smoke-result | 0 | — | — | `validation/v1.0.0-rc.1-release/logs/consumer-run.log` |

Totals: 43 steps, 0 failed steps; 894 test executions: 447 distinct cases, 447 of them executed a second time in the rebuilt copy (the `rebuild-*` steps); 894 passed, 0 skipped/not run. Blocked steps: 0.

The `rebuild-*` steps ran inside a fresh directory created with `mkdtemp` in the OS temp dir: the source tarball was unpacked there, `npm ci` installed from the lockfile, the workspace was built and type-tested, and the core, application and PostgreSQL/matrix suites plus the filesystem demo ran against that copy. `pack-*` produced the npm tarballs from the rebuilt copy; `consumer-*` installed them into an independent TypeScript project, compiled it and ran it.

## Release artefacts

The 2 source archives and 2 npm packages of the run this page was generated from are listed with sizes and SHA-256 digests in that run's `SHA256SUMS.txt` and under `release` in its `manifest.json`. They are not copied here: this page is generated from the run and is not part of the archived source, so the run of reference — `RELEASE_MANIFEST.json` and `validation/v1.0.0-rc.1-release/SHA256SUMS.txt`, committed with this page — carries the hashes to check. Rebuilt from `work/release/syna-v1.0.0-rc.1-source.tar.gz`. Consumer smoke result (last line of `validation/v1.0.0-rc.1-release/logs/consumer-run.log`): `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0,"revisions":"7.3.1","slots":"ready,ready"}`.

## Micro-benchmarks (P01–P04, `validation/v1.0.0-rc.1-release/benchmark-v0.5.json`)

Setups are empty and involve no network. Warm cases measure enter+dispose of a sibling Entry with a cached plan template; percentiles are over individual iterations after warmup. Numbers are machine-specific; cache cardinality and bounded growth are the portable assertions. Warmup iterations: 50. Quick mode: false.

| case | samples | p50 ms | p95 ms | p99 ms | inherited / new | plan-cache entries |
|---|---:|---:|---:|---:|---|---:|
| warm-enter-dispose-100-depth-2 | 500 | 0.113 | 0.180 | 0.227 | 100 / 20 | 4 |
| warm-enter-dispose-100-depth-6 | 500 | 0.108 | 0.184 | 0.305 | 100 / 20 | 8 |
| warm-enter-dispose-300-depth-2 | 500 | 0.267 | 0.396 | 0.455 | 260 / 60 | 4 |
| warm-enter-dispose-300-depth-6 | 500 | 0.251 | 0.375 | 0.420 | 260 / 60 | 8 |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.198 | 0.328 | 0.415 | 140 / — | 2 |
| bound-entry-private-range-request-enter-dispose-100 | 500 | 0.123 | 0.177 | 0.278 | 101 / 21 | 4 |
| override-and-all-request-enter-dispose-100 | 500 | 0.115 | 0.165 | 0.214 | — | — |

Phase breakdown (300-service world, 60 rounds): cold plan + new slots p95 23.128 ms · warm plan p95 0.473 ms · materialization of a request chain p95 0.063 ms · dispose p95 0.133 ms.

Churn: 10000 request/AnchoredEntry operations in 1263 ms (126.3 µs/op); plan-cache entries max 4 (hits 9998, misses 4); live Envs after 2; heap after GC: 7.0 MiB → 7.2 MiB → 7.3 MiB → 7.3 MiB → 7.3 MiB.

LRU: 500 distinct Entry shapes → 16 cached templates (max 16, evictions 484).

### Budgets (`benchmarks/budgets.json`) — all ok: true

| budget | metric | max | value | result |
|---|---|---:|---:|---|
| warm-enter-dispose-300-depth-2 | p95Ms | 2 | 0.396 | ok |
| warm-enter-dispose-300-depth-6 | p95Ms | 2 | 0.375 | ok |
| warm-enter-dispose-100-depth-2 | p95Ms | 1 | 0.180 | ok |
| bound-entry-private-range-request-enter-dispose-100 | p95Ms | 1 | 0.177 | ok |
| churn-10000-requests | planCacheEntriesMax | 8 | 4.000 | ok |
| churn-10000-requests-liveEnvs | liveEnvCountAfter | 2 | 2.000 | ok |
| lru-churn-500-shapes | planCacheEntries | 16 | 16.000 | ok |

### 0.8.0 comparison on the same machine (`validation/v1.0.0-rc.1-release/benchmark-compare/same-session.json`)

`scripts/benchmark-same-session.mjs` ran `benchmarks/v0.5-planning.mjs` 21 times on this host, took the element-wise median and compared it with the 0.8.0 source (commit `e24859f`) exported from git into a scratch directory, installed from its lockfile, built and benchmarked 21 times in the same session (`scripts/benchmark-same-session.mjs`: one discarded warm-up run per side, then 21 rounds that benchmark both sides in alternating order, both benchmark processes under `--expose-gc --no-maglev`; medians in `validation/v1.0.0-rc.1-release/benchmark-compare/`): environment identical (platform darwin, arch arm64, cpu Apple M4 Pro, cpuCount 14, node (major) v26, node flags --expose-gc --no-maglev); 23/23 p50/p95/per-operation values within ±10 %; 116/116 plan-cache counters and shape counts equal; overall OK.

Machine-state drift (informational): this session's 0.8.0 against the file recorded on 2026-09-07T05:11:33.442Z (`benchmarks/results-v0.8.0-baseline-same-machine.json`) has 22/23 timings within ±10 %; outside: cases.phase-breakdown-300.materializationMs.p50Ms -11.4 % — the same code measured at two moments, which is why both sides are measured in one session.

| value | baseline (0.8.0) | this source (1.0.0-rc.1) | delta |
|---|---:|---:|---:|
| cases.warm-enter-dispose-100-depth-2.timing.p50Ms | 0.100 | 0.101 | +0.6 % |
| cases.warm-enter-dispose-100-depth-2.timing.p95Ms | 0.181 | 0.182 | +0.4 % |
| cases.warm-enter-dispose-100-depth-6.timing.p50Ms | 0.097 | 0.097 | -0.3 % |
| cases.warm-enter-dispose-100-depth-6.timing.p95Ms | 0.181 | 0.182 | +0.2 % |
| cases.warm-enter-dispose-300-depth-2.timing.p50Ms | 0.251 | 0.251 | +0.3 % |
| cases.warm-enter-dispose-300-depth-2.timing.p95Ms | 0.329 | 0.332 | +0.7 % |
| cases.warm-enter-dispose-300-depth-6.timing.p50Ms | 0.245 | 0.247 | +0.6 % |
| cases.warm-enter-dispose-300-depth-6.timing.p95Ms | 0.390 | 0.392 | +0.6 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p50Ms | 19.792 | 19.762 | -0.1 % |
| cases.phase-breakdown-300.coldPlanWithNewSlotsMs.p95Ms | 21.871 | 21.669 | -0.9 % |
| cases.phase-breakdown-300.warmPlanMs.p50Ms | 0.305 | 0.309 | +1.2 % |
| cases.phase-breakdown-300.warmPlanMs.p95Ms | 0.431 | 0.435 | +0.8 % |
| cases.phase-breakdown-300.materializationMs.p50Ms | 0.029 | 0.030 | +2.3 % |
| cases.phase-breakdown-300.materializationMs.p95Ms | 0.069 | 0.071 | +3.8 % |
| cases.phase-breakdown-300.disposeMs.p50Ms | 0.081 | 0.083 | +2.7 % |
| cases.phase-breakdown-300.disposeMs.p95Ms | 0.127 | 0.129 | +1.0 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p50Ms | 0.181 | 0.180 | -0.3 % |
| cases.site-enter-tenant-input-reverse-closure-200.timing.p95Ms | 0.291 | 0.291 | -0.2 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p50Ms | 0.112 | 0.114 | +1.7 % |
| cases.bound-entry-private-range-request-enter-dispose-100.timing.p95Ms | 0.191 | 0.190 | -0.8 % |
| cases.override-and-all-request-enter-dispose-100.timing.p50Ms | 0.109 | 0.110 | +0.3 % |
| cases.override-and-all-request-enter-dispose-100.timing.p95Ms | 0.178 | 0.181 | +1.7 % |
| cases.churn-10000-requests.perOperationMs | 0.120 | 0.119 | -0.1 % |

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

## Working set (H11 / P05, `validation/v1.0.0-rc.1-release/working-set.json`)

120 tenants configured, capacity 6; max SiteEnv records per phase: hot 3, rotation 6, long tail 6, mixed 6; final records 0, evictions 480, creations 481, creation failures 0, leases 0, pending acquires 0. Heap after GC per phase: start 18.8 MiB (records 0, live envs 2, disposing 0); after-hot 19.4 MiB (records 3, live envs 5, disposing 0); after-rotation 20.2 MiB (records 6, live envs 8, disposing 0); after-tail 20.1 MiB (records 5, live envs 7, disposing 0); after-mixed 20.3 MiB (records 6, live envs 8, disposing 0); after-idle-sweep 19.8 MiB (records 0, live envs 2, disposing 0). Site Envs alive at any acquire (live envs minus the two roots, sampled on every lease): at most 6 of capacity 6. Plan cache at the end: {"hits":482,"misses":6,"entries":6,"evictions":0,"limit":512}.

## Hyla-mini request latency (report only, `validation/v1.0.0-rc.1-release/hyla-request-latency.json`)

Full HTTP round trips on 127.0.0.1 measured from a node:http client in the same process; not a budget and not a cross-machine claim. Quick mode: false. Not a budget: nothing here gates the release.

| backend | case | samples | p50 ms | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|
| filesystem | post-page-cached | 200 | 1.192 | 2.350 | 4.057 |
| filesystem | index-cached | 200 | 0.446 | 0.539 | 0.683 |
| filesystem | comment-preview-untrusted | 200 | 0.463 | 0.624 | 0.776 |
| filesystem | post-page-cold-site | 50 | 1.309 | 1.670 | 1.987 |
| postgres | post-page-cached | 200 | 0.512 | 0.781 | 1.005 |
| postgres | index-cached | 200 | 0.342 | 0.624 | 1.048 |
| postgres | comment-preview-untrusted | 200 | 0.424 | 0.632 | 0.766 |
| postgres | post-page-cold-site | 50 | 0.759 | 1.062 | 1.269 |

`post-page-cached`: GET /posts/shared-slug on a warm SiteEnv (page cache hit; still one content-version read per request). `index-cached`: GET / on a warm SiteEnv (page cache hit). `comment-preview-untrusted`: GET /comments/preview?text=… (untrusted pipeline, never cached). `post-page-cold-site`: GET /posts/shared-slug after invalidate(): SiteEnv creation (configuration read, Env, authenticator, context) plus a page-cache miss.

## Audit and review fixes covered by this run

The suites above include the regressions written for the independent audits and for the second and third review rounds (`docs/AUDIT.md`): `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs` and `v05-review-lifecycle.test.mjs` inside `core-tests` (the third round's core cases live in the `v05-*` files named in `work/v05/ISSUES.md` I-58…I-65), `apps/hyla-mini/tests/audit-app.test.mjs` and `apps/hyla-mini/tests/review-app.test.mjs` as their own steps, the site-manager, render and preflight cases of the third round inside their steps, and the repository-conformance cases (content version, domain claims and concurrent claims, tenant-scoped post identity, configuration validation) inside the filesystem and PostgreSQL suites. The demo steps are self-asserting: the Hyla-mini demo must print `demo: OK` and three `: 200` cells, and the `demos` step must print `demo: OK` once per core demo (each checks its own results); exit 0 alone is not enough. The `gate-self-tests` step covers the gate's own tooling (step process groups, cluster script signal forwarding).

## Frozen-surface evidence in this run

The claim of this line — the public surface of `@syna/core` frozen from 0.8.0 (`docs/API_STABILITY.md`) and the core unchanged since — rests on steps of this run. `api-inventory` (exit 0), `api-inventory-no-deprecated` (ok: 374 items, 0 @deprecated), `api-inventory-diff` (exit 0; 374 items in the 0.8.0 record, 374 here: 0 added, 0 removed, 0 changed in signature, 0 changed in JSDoc only, 0 newly deprecated) and `api-inventory-frozen` (ok: 374 items here, 374 in the 0.8.0 record (validation/v0.8-release/api-inventory.json, commit 38a722e); 0 of the record's items changed or removed, 0 items new or changed) record the public API of this source, assert that no item of it is deprecated, diff it against the 0.8.0 record (`validation/v0.8-release/api-inventory.json`) and require it to be identical to that record item by item — path, kind, signature, JSDoc and deprecation. Planning layer unchanged: `core-tests` includes `v06-snapshots.test.mjs` (the check/explain/inspect/catalog/error snapshots recorded on 0.5.0, rewritten by the registered renames only — `packages/core/tests/snapshots/v05-renames.json` — and identical otherwise, the limit defaults verbatim) and `reference-planner.test.mjs` (brute-force planner differential, unchanged). The 0.8 rename stays guarded: the `v08-*` suites in `core-tests` — `v08-implementation-ref` (one serialized shape of an implementation reference on every write path; every pre-0.8 form refused by `parseImplementationRef()` and by the four Runtime read paths with `INVALID_DESCRIPTOR`), `v08-slot-state` (the declared `SlotState` union equals the set of states a slot is actually seen in), `v08-deadline-queue` (the process-wide DeadlineQueue: Runtimes isolated, a settled waiter holds the process open for nothing), `v08-expired-forms` (the four 0.7 forms the Runtime could otherwise read silently are refused naming the current form) — with `v07-expired-forms` and `v07-s7-invalid-descriptor`. `gate-self-tests` (26/26 pass) includes the empty deprecation register, the no-old-names scan of every application, benchmark, script, workflow, test suite and current document for the pre-0.8 names, the codemod run on a fixture consumer, the public-API inventory assertions (exactly the rename table against the 0.7.0 record; identity with the 0.8.0 record) and the doc-aware diff renderer, the README example compiled and run as printed, and the `any` budget; `codemod-idempotent` (exit 0; 0 edits in 0 files, 0 sites needing a hand) is `scripts/codemod-v08.mjs --dry-run` on this source, repeated inside the unpacked archive as `rebuild-codemod-idempotent` (exit 0); `no-old-reference-tokens` (ok: 56 files scanned, 0 hits) scans the core source, tests and type tests for the 0.5 serialized key, the old kind and the word that named the old read path; `any-count` (exit 0) checks every file against `scripts/any-baseline-v0.7.0.json`; `benchmark-compare` (exit 0) is the same-machine comparison with 0.8.0 above.

## What is not covered

- Coverage percentages are not a gate; the adversarial and application suites are.
- Benchmarks use empty setups; Hyla-mini request latency (section above) is reported end to end on this machine but is not a budget and not a cross-machine claim.
- The gate ran with no other workload on the machine; single-run timings still carry noise (see the v0.4 comparison for the spread between two runs of the same code).
- The same-machine comparison (section above) measures both benchmark processes under `--expose-gc --no-maglev` (1.0.0-rc.1 on; `scripts/benchmark-same-session.mjs`, the flags recorded in every run file). Without V8's Maglev tier the tier-up race that made a benchmark process fast or slow for its whole timed loop — the bimodal p95 of the 0.6 to 0.8 release runs, about 0.21 ms or 0.30 ms for `site-enter-tenant-input-reverse-closure-200` on both sides alike (`work/v08/STATE.md`, Phase E) — is gone: every process of a run lands at the former slow mode's p95 level (0.27–0.33 ms on this machine) with the fast mode's p50, on both sides. The tolerance (±10 %), the statistic (element-wise median of 21 interleaved rounds) and the counters' equality are unchanged, and `scripts/benchmark-compare.mjs` reports two records measured under different flags as not comparable. The budget table above (`benchmark-v0.5.json`) is still measured without the flag, so its p95 values are not comparable with the comparison's.

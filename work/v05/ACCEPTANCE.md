# Acceptance map (K/H/R/P → tests / commands / evidence)

Status: DONE = test exists and passes in `validation/v0.5-dev/manifest.json` (and later in the release run). Evidence paths are relative to the workspace root. Test file paths under `packages/core/tests/` and `apps/hyla-mini/tests/`.

## K — core semantics
| Item | Evidence | Status |
|------|----------|--------|
| K01 Runtime finite/closed/inert | v05-definitions.test.mjs "K01 …"; core.test.mjs "Runtime construction creates no Env…" | DONE |
| K02 Entry + single-parent Env, Ready anchor only, OWNER_NOT_READY | hardening.test.mjs (migrated M-05), v04-corrections.test.mjs, v05-realms-override.test.mjs R08, preflight.test.mjs H13 | DONE |
| K03 parent-only reuse fixed point | v05-planner.test.mjs R12/K03, reference-planner.test.mjs (200 seeds + diamond), core.test.mjs fresh/share/SCC | DONE |
| K04 lineage anchors persist | v05-planner.test.mjs R13 (two tests) | DONE |
| K05 Input/Binding | v05-planner.test.mjs R16, v05-promises.test.mjs R05, hardening.test.mjs asymmetry | DONE |
| K06 semver/contracts/candidates | semver.test.mjs, v05-definitions.test.mjs R01, v05-planner.test.mjs R14/R15, contracts.test.mjs | DONE |
| K07 plain Promises, deadline | v05-promises.test.mjs (9 tests), lifecycle.test.mjs (migrated M-07) | DONE |
| K08 attempt/waiter/slot | v05-attempts.test.mjs (8 tests) | DONE |
| K09 cleanup & Ready | v05-cache-cleanup.test.mjs R19/K09, lifecycle.test.mjs dispose order | DONE |
| K10 BoundEntry realm/anchor | v05-realms-override.test.mjs R07/R08/K10, v04-finalization.test.mjs owner-entry-context | DONE |
| K11 override compiled view | v05-realms-override.test.mjs R06, v04-regressions/v04-corrections override tests | DONE |
| K12 check/explain | v05-explain.test.mjs (2 tests), v05-planner R16 (missing params), preflight.test.mjs H12 | DONE |

## H — Hyla-mini
| Item | Evidence | Status |
|------|----------|--------|
| H01 data model | preflight.test.mjs "H01 …", helpers/repository-conformance.mjs | DONE |
| H02 real PostgreSQL | postgres.test.mjs (22 tests, temp cluster via scripts/pg-test-cluster.mjs), matrix.test.mjs | DONE |
| H03 filesystem + layouts | filesystem.test.mjs (43 tests; both layouts, rename round-trip, traversal, symlink, atomic write, concurrency) | DONE |
| H04 2×2 matrix | matrix.test.mjs (PG→HTTP, PG→static, FS→HTTP, FS→static, cross-backend equality, leak scan) | DONE |
| H05 three recipes / shared factories | render.test.mjs (sharing counts, concurrency, validation) | DONE |
| H06 factory constraints + preflight | preflight.test.mjs H06 ×3 (RequestAwareStageFactory refused, SiteAwareRenderer refused, pollution probe) | DONE |
| H07 recipe persistence | render.test.mjs H07 | DONE |
| H08 tenants/domains/isolation | tenants-auth.test.mjs H08 ×2, matrix.test.mjs | DONE |
| H09 auth replaceable | tenants-auth.test.mjs H09 | DONE |
| H10 SiteEnv working set | site-manager.test.mjs H10 ×3 | DONE |
| H11 scale/config heat | site-manager.test.mjs H11/P05 (120 tenants), shutdown concurrency | DONE |
| H12 request fork budget | preflight.test.mjs H12 ×2, src/site/preflight.ts, app.ts REQUEST_BUDGET | DONE |
| H13 worker | preflight.test.mjs H13 | DONE |

## R — counterexamples (all in packages/core/tests, test names start with the R number)
R01 v05-definitions · R02/R03/R04/R05 v05-promises · R06/R07/R08 v05-realms-override · R09/R10/R11 v05-attempts · R12/R13/R14/R15/R16 v05-planner · R17/R18/R19 v05-cache-cleanup · R20 v05-definitions · reference planner: reference-planner.test.mjs — all DONE (130 core tests in the dev gate).

## P — performance / working set
| Item | Evidence | Status |
|------|----------|--------|
| P01 environment/percentiles/phases | benchmarks/v0.5-planning.mjs → validation/v0.5-*/benchmark-v0.5.json (`environment`, `phase-breakdown-300`) | DONE |
| P02 coverage (100/300, Binding/auto/all/BoundEntry, SCC, Input closure, private range, override, churn) | same JSON, cases list | DONE |
| P03 300-node warm enter+dispose p95 ≤ 2 ms + v0.4 same-machine baseline | budgets.json; results-v0.4.0-baseline-same-machine.json; results-v0.4-workload-on-v0.5-same-machine.json | DONE |
| P04 10k churn bounded | `churn-10000-requests` case + v05-cache-cleanup R18 | DONE |
| P05 working set bounded with heap samples | site-manager.test.mjs H11 → validation/working-set.json | DONE |
| P06 cache key structure / neutrality | plan-cache.ts (structured key string, no payload/ids), v05-cache-cleanup R17 | DONE |
| P07 budgets locked machine-readably | benchmarks/budgets.json (lockedAt 2026-09-04) | DONE |

## G — gates
| Gate | Command | Status |
|------|---------|--------|
| G0 | `node scripts/verify-v05.mjs --dev` → validation/v0.5-dev/manifest.json (COMPLETE, 217 tests, 0 skipped) | DONE |
| A1 | Independent audit — Promise/lifecycle (fresh-context subagent; `docs/audit/promise-lifecycle/`) | DONE — 8 findings, 7 fixed + 1 documented; regressions `v05-audit-lifecycle.test.mjs` (14) |
| A2 | Independent audit — application/permissions/resources (`docs/audit/app-permissions/`) | DONE — 13 findings (+1 found on re-probe), all fixed or documented; regressions `audit-app.test.mjs` (12) + conformance (2 × 2 backends) |
| A3 | Independent audit — cache/delivery/DX (`docs/audit/cache-delivery/`) | DONE — 10 findings fixed/mitigated; regressions `v05-audit-planning.test.mjs`; F-CD-03 closed by the release run |
| A4 | Fix verification: auditors' probes re-run against the fixed build; remaining FAIL lines explained in ISSUES.md | DONE (not an independent re-audit — the implementer verified the fixes) |
| G1 | `node scripts/verify-v05.mjs --release` → RELEASE_MANIFEST.json, validation/v0.5-release/SHA256SUMS.txt, work/release/*.tar.gz|zip | PENDING (run after audit fixes are committed) |

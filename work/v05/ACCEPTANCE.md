# Acceptance map (K/H/R/P → tests / commands / evidence)

Status: DONE = test exists and passes in `validation/v0.5-dev/manifest.json` (and later in the release run). Evidence paths are relative to the workspace root. Test file paths under `packages/core/tests/` and `apps/hyla-mini/tests/`.

## K — core semantics
| Item | Evidence | Status |
|------|----------|--------|
| K01 Runtime finite/closed/inert | v05-definitions.test.mjs "K01 …"; core.test.mjs "Runtime construction creates no Env…"; re-audit: F-CL3-01 (selector candidates per physical revision across Runtimes), F-CL3-04 (key-order planning) | DONE |
| K02 Entry + single-parent Env, Ready anchor only, OWNER_NOT_READY | hardening.test.mjs (migrated M-05), v04-corrections.test.mjs, v05-realms-override.test.mjs R08, preflight.test.mjs H13 | DONE |
| K03 parent-only reuse fixed point | v05-planner.test.mjs R12/K03, reference-planner.test.mjs (200 seeds + diamond), core.test.mjs fresh/share/SCC | DONE |
| K04 lineage anchors persist | v05-planner.test.mjs R13 (two tests) | DONE |
| K05 Input/Binding | v05-planner.test.mjs R16, v05-promises.test.mjs R05, hardening.test.mjs asymmetry | DONE |
| K06 semver/contracts/candidates | semver.test.mjs, v05-definitions.test.mjs R01, v05-planner.test.mjs R14/R15, contracts.test.mjs; third round: range = Contract view (R07 covering/non-covering, type-tests/api.ts), setup digest R20 | DONE |
| K07 plain Promises, deadline | v05-promises.test.mjs (9 tests), lifecycle.test.mjs (migrated M-07) | DONE |
| K08 attempt/waiter/slot | v05-attempts.test.mjs (8 tests); v05-review-lifecycle.test.mjs R-1 (failed rollback final), R-3/R-4 (bounded close, ledger, dependencies acknowledged); re-audit: v05-audit3-lifecycle-planning.test.mjs F-CL3-03 (dropped handle closed as unreachable), F-CL3-05a/b/c (rolling-back/settling ledger, `runtime.dispose()` grace), F-CL3-08 (`error.result`); R-3 tightened | DONE |
| K09 cleanup & Ready | v05-cache-cleanup.test.mjs R19/K09, lifecycle.test.mjs dispose order | DONE |
| K10 BoundEntry realm/anchor | v05-realms-override.test.mjs R07/R08/K10 (third round: range-only private Family, owners of forked nodes), v04-finalization.test.mjs owner-entry-context; plan templates keyed by lineage anchors (v05-cache-cleanup R17 anchors) | DONE |
| K11 override compiled view | v05-realms-override.test.mjs R06, v04-regressions/v04-corrections override tests | DONE |
| K12 check/explain | v05-explain.test.mjs (2 tests + K12 planning-purity boundary: own ids, `inspect().definitions`), v05-planner R16 (missing params), preflight.test.mjs H12; re-audit: F-CL3-09 (`check-slot-N` ids), F-CL3-02 (drift diagnosed after `check()`) | DONE |

## H — Hyla-mini
| Item | Evidence | Status |
|------|----------|--------|
| H01 data model | preflight.test.mjs "H01 …", helpers/repository-conformance.mjs | DONE |
| H02 real PostgreSQL | postgres.test.mjs (31 tests, temp cluster via scripts/pg-test-cluster.mjs; third round: composite post key + legacy migration, transactional mutation + bump, pool destroy policy, raw JSONB validation), matrix.test.mjs; re-audit: postgres.test.mjs F-BD3-01/04/06/07/08, conformance F-BD3-02/03/04/05/12 | DONE |
| H03 filesystem + layouts | filesystem.test.mjs (55 tests; both layouts, rename round-trip, traversal, symlink, atomic write, concurrency; third round: corrupt site.json, pending-version marker) + conformance (domain claims incl. concurrent, tenant-scoped ids, configuration validation); re-audit: F-BD3-09 duplicate-id repair ×2, conformance F-BD3-02/03/04/05/12 | DONE |
| H04 2×2 matrix | matrix.test.mjs (PG→HTTP, PG→static, FS→HTTP, FS→static, cross-backend equality, leak scan) | DONE |
| H05 three recipes / shared factories | render.test.mjs (sharing by per-instance tokens, concurrency, validation; third round: bounded pipeline LRU, untrusted recipe policy, renderer fallbacks) | DONE |
| H06 factory constraints + preflight | preflight.test.mjs H06 ×3 (RequestAwareStageFactory refused, SiteAwareRenderer refused, pollution probe) | DONE |
| H07 recipe persistence | render.test.mjs H07 | DONE |
| H08 tenants/domains/isolation | tenants-auth.test.mjs H08 ×2, matrix.test.mjs | DONE |
| H09 auth replaceable | tenants-auth.test.mjs H09 | DONE |
| H10 SiteEnv working set | site-manager.test.mjs H10 ×3; third round S2 (reservation hand-off), S5 (monotonic rotation ×2), S6 (lease purposes ×2); re-audit F-AP3-03/04/05/07 | DONE |
| H11 scale/config heat | site-manager.test.mjs H11/P05 (120 tenants), shutdown concurrency | DONE |
| H12 request fork budget | preflight.test.mjs H12 ×2, src/site/preflight.ts, app.ts REQUEST_BUDGET | DONE |
| H13 worker | preflight.test.mjs H13; third round: audit-app S4 (supervised loop, `failed`, child process), S9 (domain table reload per tick) | DONE |

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
| A5 | Second review round (4 items, 2026-09-05): rollback finality + cancellation rejections, Hyla leak/capacity/cache race, unbounded retention after bounded close, abandoned attempt vs. disposed dependencies | DONE — I-50…I-57; 7 fixed with regressions `v05-review-lifecycle.test.mjs` (6) + `review-app.test.mjs` (6), 1 shown inherent under the model (D34, argument in docs/AUDIT.md) |
| A6 | Third review round (two auditors, ~35 findings on 6bb36c2, 2026-09-05): core (range origin and Contract view, anchors in plan-template keys, dispose-vs-deadline, planning purity, setup drift), site manager (hand-off, monotonic rotation, lease purposes, worker supervision, close report, startup request preflight, domain reload/IDNA), caches and security (bounded single-flight page cache, pipeline LRU, untrusted recipe policy, configuration validation), static output (symlink defence, snapshot render, ordered atomic publish, build lock), backends (composite post identity, transactional bump, domain ownership, pool policy), delivery (self-asserting demo, gate output assertions, honest totals, CI release-gate job) | DONE — I-58…I-84, D35…D53, M-22…M-30; every fix with a regression shown failing on the pre-fix sources; docs/AUDIT.md "Third review round"; CI job written but not run in the cloud |
| A7 | Independent re-audit of the third round (three fresh-context auditors on 32d212a, 2026-09-05; 35 findings: 9 core, 8 application, 18 backends/delivery): core (selector cache per physical revision, drift on template hits, strongly held attempt ledger, key-order planning, rolling-back/settling ledger states, `run()` result on close errors, planning ids), site manager and rendering (closing records free their key, eviction only when useful, shutdown-cut creation, one acquire deadline, per-configuration sanitizer identity with verified append, backslash hrefs, manifest provenance, listing-based static render), backends (aborted-transaction error, conflict check before delete, per-tenant lock, re-entrancy refusal, inner serialization, one-time back-fill, bounded pool close, duplicate repair, NUL refusal, `listTenants` union), delivery (step process groups and signal forwarding, self-asserting demos, recorded PostgreSQL server, run comparison, wording, repository-only ledgers) | DONE — I-85…I-119, D54…D65, M-31…M-35; two documented limits (close bound per tree level, filesystem durability = process crash); every regression shown failing on the pre-fix sources; probes re-run (only lines asserting the old behaviour or the documented bound still fail); docs/AUDIT.md "Independent re-audit of the third round" |
| G1 | `node scripts/verify-v05.mjs --release` → RELEASE_MANIFEST.json, validation/v0.5-release/SHA256SUMS.txt, work/release/*.tar.gz|zip | DONE — 2026-09-05 run at commit 7d5bf55 (clean): exit 0, COMPLETE, 30 steps, 506/506 tests, 0 skipped, fingerprint 68119800…43a79 (224 files); archive rebuilt in a fresh mkdtemp directory (npm ci, build, type-tests, 148 core + 78 app + 27 PostgreSQL/matrix tests, demo), consumer smoke `{"result":42,"revision":"7.3.1","explainOk":true}`. Final run on the source that includes docs/VALIDATION.md (commit ded5f10, clean): exit 0, COMPLETE, same 30 steps and 506/506 tests, fingerprint ce43ce69…7864c, tar.gz sha256 d574dfda…27ff73, zip 94f8a682…c08754 — superseded by the final run on f19fcda after the identity rewrite (fingerprint 20bc30cb…879f8, tar.gz 95299d2c…4b25cb, zip ff45ac0d…d189bf), which is what RELEASE_MANIFEST.json now records. Second review round (2026-09-05): re-run on 0434be0 (clean) — exit 0, COMPLETE, 31 steps, 530/530 tests, fingerprint 1c7128c6…8a6d (227 files), docs/VALIDATION.md regenerated from it; the final run on the source that includes the regenerated document is the one RELEASE_MANIFEST.json records (STATE.md). |

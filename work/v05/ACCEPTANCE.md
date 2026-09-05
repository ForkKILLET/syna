# Acceptance map (K/H/R/P → tests / commands / evidence)

Status legend: TODO / WIP / DONE (evidence path)

## K — core semantics
| Item | Evidence | Status |
|------|----------|--------|
| K01 | packages/core/tests/core.test.mjs (runtime creates no env/instance) | TODO |
| K02 | v05-entries.test.mjs: ready anchor only, OWNER_NOT_READY | TODO |
| K03 | v05-planner.test.mjs + reference-planner.test.mjs | TODO |
| K04 | v05-planner.test.mjs (R13) | TODO |
| K05 | v05-inputs.test.mjs (R05, R16) | TODO |
| K06 | semver.test.mjs, v05-versions.test.mjs (R01, R15) | TODO |
| K07 | v05-promises.test.mjs (R02, R03, R04) | TODO |
| K08 | v05-attempts.test.mjs (R09, R10) | TODO |
| K09 | v05-cleanup.test.mjs (R11, R19) | TODO |
| K10 | v05-entries.test.mjs (R07, R08) | TODO |
| K11 | v05-override.test.mjs (R06) | TODO |
| K12 | v05-explain.test.mjs | TODO |

## H — Hyla-mini
| Item | Evidence | Status |
|------|----------|--------|
| H01 | apps/hyla-mini/tests/model.test.mjs | TODO |
| H02 | apps/hyla-mini/tests/postgres.test.mjs (real PG) | TODO |
| H03 | apps/hyla-mini/tests/filesystem.test.mjs | TODO |
| H04 | apps/hyla-mini/tests/matrix.test.mjs | TODO |
| H05 | apps/hyla-mini/tests/recipes.test.mjs | TODO |
| H06 | apps/hyla-mini/tests/preflight.test.mjs | TODO |
| H07 | apps/hyla-mini/tests/recipes.test.mjs (persistence) | TODO |
| H08 | apps/hyla-mini/tests/tenants.test.mjs | TODO |
| H09 | apps/hyla-mini/tests/auth.test.mjs | TODO |
| H10 | apps/hyla-mini/tests/site-manager.test.mjs | TODO |
| H11 | apps/hyla-mini/tests/working-set.test.mjs | TODO |
| H12 | apps/hyla-mini/tests/budget.test.mjs | TODO |
| H13 | apps/hyla-mini/tests/worker.test.mjs | TODO |

## R — counterexamples
R01–R20: packages/core/tests/v05-*.test.mjs (one `test()` per item, named `R0x ...`) — TODO

## P — performance / working set
| Item | Evidence | Status |
|------|----------|--------|
| P01–P04 | benchmarks/v0.5-planning.mjs → benchmarks/results-v0.5.0.json | TODO |
| P05 | apps/hyla-mini/tests/working-set.test.mjs → validation/working-set.json | TODO |
| P06 | plan-cache tests (R17) | TODO |
| P07 | benchmarks/budgets.json | TODO |

## G — gates
| Gate | Command | Status |
|------|---------|--------|
| G0 | node scripts/verify-v05.mjs --dev | TODO |
| G1 | node scripts/verify-v05.mjs --release | TODO |

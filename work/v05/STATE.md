# Syna v0.5 + Hyla-mini — STATE

## Current phase
Second review round DONE (2026-09-05, after the 0.5.0 release gate of the same day). Four reviewer items — (1) a failed rollback could be retried and a caught cancellation could leave a rejected Promise; (2) Hyla tenant Env leak, eviction releasing capacity early, page-cache version race; (3) an Env with an abandoned attempt stayed `disposing` and retained without bound after the bounded close; (4) rollback-then-restart stacking resources, unhandled rejections after caught cancellation, an abandoned setup running while its dependencies were disposed — are I-50…I-57 (ISSUES.md), decisions D31…D34, regression tests `packages/core/tests/v05-review-lifecycle.test.mjs` (6) and `apps/hyla-mini/tests/review-app.test.mjs` (6), documented in docs/AUDIT.md "Second review round", the semantic model (§11, §13, §14), SEMANTIC_CHANGES §4, API_REFERENCE, MIGRATION M-18/M-20/M-21, HYLA_MINI.md and CHANGELOG. Seven items fixed; item 4c (dependencies of an abandoned attempt are closed while it may still run) is shown to be inherent under the model (no bounded close can wait for a runaway attempt; §14 excludes termination and revocation; retaining the dependencies would be item 3 one level up) and is acknowledged in the `UNSETTLED_ATTEMPT` report instead.
Local verification of this round: typecheck + type tests clean; core 154/154; app 73/73 + review 6/6 + site-manager 5/5; the auditors' probes re-run against the fixed build (only the intended FAIL lines remain; the lifecycle probe that expected `rootEnvCount 0` while an attempt is outstanding now passes). This round's own probes are archived under `work/v05/probes/review-2026-09-05/`. `docs/VALIDATION.md` is now produced by `scripts/validation-doc.mjs` from a run directory. Release-gate re-run for this round: see "Release gate after the second review round" below.

## Release gate after the second review round
Run 1 (2026-09-05) on commit 0434be0 (clean tree): exit 0, COMPLETE, 31 steps (new step `hyla-review-regression-tests`), 530/530 tests, 0 skipped, source fingerprint 1c7128c6cb435de0285ed27ec78c93be9334769cd833966173068866a5ff8a6d (227 files); archives tar.gz 395932 B sha256 3222244b…f125ee, zip 510343 B sha256 777ca7e7…218991, core tgz 92481 B sha256 dd6f344a…f76a31, tsconfig tgz unchanged (81861252…25cbf). docs/VALIDATION.md regenerated from this run's manifest by `scripts/validation-doc.mjs`. Run 2 (final, on the source that includes the regenerated VALIDATION.md): (filled in by the evidence commit).

## Release 0.5.0 gate (2026-09-05, before the second review round)
DONE (2026-09-05). Final `node scripts/verify-v05.mjs --release` on commit ded5f10 (clean tree): exit 0, COMPLETE, 30 steps, 506/506 tests, 0 skipped, source fingerprint ce43ce696ca9c6eacb6765b289f44f1fdcbe25f2dc54c3f6c7d585fc0a17864c (224 files); archives work/release/syna-v0.5.0-source.tar.gz (373781 B, sha256 d574dfda…27ff73), .zip (484783 B, sha256 94f8a682…c08754), pack/syna-core-0.5.0.tgz (88811 B, 497c07d3…da329), pack/syna-tsconfig-0.5.0.tgz (1483 B, 81861252…25cbf). Evidence: RELEASE_MANIFEST.json, validation/v0.5-release/ (manifest, SHA256SUMS.txt, benchmark, working set, archive scan, logs force-added despite *.log ignore).
Release-gate history (2026-09-05): run 1 PARTIAL — archive scan rejected two strings in the archived cache-delivery audit report (reworded, 4a35776); run 2 PARTIAL — H10 backpressure test raced on concurrent config reads (test fixed, 7d5bf55, I-49); run 3 COMPLETE at 7d5bf55 (fingerprint 68119800…43a79, source of docs/VALIDATION.md numbers); run 4 COMPLETE at ded5f10 (final, includes docs/VALIDATION.md).
No remote push, no npm publish, no deployment; the user's PostgreSQL on 5432 was never used.

## History rewrite (2026-09-05)
All 13 commits had been made as `syna-v05 <wangxinhe06@gmail.com>` (taken from the task book) instead of the user's global gitconfig identity. Rewritten with `git filter-branch --env-filter` (author + committer → gitconfig identity; trees, dates and messages unchanged; verified pairwise). Pre-rewrite → post-rewrite: 395e089→de1d441, d8b19c7→7b31678, 61ec315→14c88d5, ff09eef→7bf1da6, 0240b6f→afb8396, d6c7541→00a0e82, 397180e→069248b, e2a6c73→05a3a75, e1a2ab8→5c702b9, c9006e4→4a35776, f9a3b35→7d5bf55, f91c2ab→ded5f10, 582e3b5→052b599. RELEASE_MANIFEST.json of run 4 recorded `f91c2ab` (= ded5f10, same tree); run 5 (final) was executed afterwards on commit f19fcda (clean, corrected identity, docs pointing at the rewritten hashes): exit 0, COMPLETE, 30 steps, 506/506, fingerprint 20bc30cb0f79c8cd4a24825076d3772d25ab58b2ad6afaaeb5a81ebdaec879f8; tar.gz 373925 B sha256 95299d2c…4b25cb, zip 484972 B sha256 ff45ac0d…d189bf, core tgz and tsconfig tgz unchanged (497c07d3…, 81861252…). Rule recorded in the user's global CLAUDE.md. A remote `origin` (git@github.com:synajs/syna-v05.git) exists and its `main` still holds the pre-rewrite commits (tip 582e3b5); nothing was pushed by this task — updating the remote requires the user to run `git push --force-with-lease origin main`.

## Environment (recorded 2026-09-04, local machine)
- Host: Darwin 25.2.0 arm64, Apple M4 Pro (14 cores), 48 GiB RAM
- Node v26.0.0, npm 11.12.1 (pnpm 11.17.0 present but NOT used; baseline is npm workspaces)
- TypeScript resolved by `npm install` from baseline range: 5.9.3; @types/node 22.20.1
- PostgreSQL 17.10 (Homebrew `postgresql@17`): `initdb`/`pg_ctl`/`psql` available.
  A user cluster listens on 5432 — NOT used. Tests use a temporary cluster created by
  `scripts/pg-test-cluster.mjs` (initdb into work/pg, port 54329) or `SYNA_TEST_PG_URL`.
- Docker 28.4.0 installed but daemon not running → not used.
- Claude Code 2.1.261

## Baseline
- Source: `~/Downloads/syna-v0.4.0-source.tar.gz`
  sha256 e0f21a94765aeb9f8e9e7987d596844e4d1bf56fce3584c8de1358131f42a96c (318 entries; identical to unpacked copy).
- Imported into this workspace as git commit `de1d441` (repo initialised here; there was no git before).
- Baseline `npm run check` on this machine: exit 0; runtime tests 88 pass / 0 fail (see work/v05/logs/baseline-check.log).
- Baseline has no lockfile; committed `dist/` outputs; hand-written semver.

## Actual failures / open items
None open. Local verification after the audit fixes (2026-09-05): core 144/144, type-tests pass, app 73/73 + site-manager 5/5, PostgreSQL + matrix 27/27 on the temporary cluster, quick benchmarks within budgets. Auditors' probes re-run; remaining FAIL lines are intended-behaviour changes listed at the end of ISSUES.md. After the second review round: core 154/154, app 73/73 + review 6/6 + site-manager 5/5 (see "Current phase").
Documented-only items: F-PL-08 (D22), F-CD-04 residual template size, F-CD-07 backend request timing not benchmarked, F-AP-10 core cannot check interface compatibility of overrides at runtime, I-57/D34 dependencies of an abandoned attempt are closed in order while it may still run (inherent).

## Modified files
- (Phase A) work/v05/*.md, .gitignore, package-lock.json

## Next steps
1. Repo hygiene: drop committed dist, add lockfile, bump to 0.5.0.
2. Probe tests of v0.4 kernel against v0.5 requirements (record failures in ISSUES.md).
3. Hyla-mini skeleton: FS + PG repositories, HTTP page, static build.

## Resources created by this task (cleanup list)
- work/pg/ (temporary PostgreSQL cluster data, gitignored) — stopped/removed by scripts/pg-test-cluster.mjs stop
- work/release/ (archives, packed tarballs, staging copy syna-v0.5.0-source/; gitignored)
- validation/v0.5-release/ and RELEASE_MANIFEST.json (committed evidence of the final run)
- rebuild directories are created with mkdtemp under the OS temp dir and removed by the orchestrator (none left after the runs)

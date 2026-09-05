# Syna v0.5 + Hyla-mini — STATE

## Current phase
Phase E: audit findings applied (I-17…I-48, all confirmed defects fixed with regression tests; see ISSUES.md), docs and ledgers updated, audit reports/probes archived to docs/audit/.
G0 dev gate: COMPLETE earlier (pre-audit source); must be re-run as part of G1 on the final source.
Next: commit → `node scripts/verify-v05.mjs --release` (nothing else running) → refresh docs/VALIDATION.md from RELEASE_MANIFEST.json → final commit → session report with the real command summary and archive list.

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
- Imported into this workspace as git commit `395e089` (repo initialised here; there was no git before).
- Baseline `npm run check` on this machine: exit 0; runtime tests 88 pass / 0 fail (see work/v05/logs/baseline-check.log).
- Baseline has no lockfile; committed `dist/` outputs; hand-written semver.

## Actual failures / open items
None open. Local verification after the audit fixes (2026-09-05): core 144/144, type-tests pass, app 73/73 + site-manager 5/5, PostgreSQL + matrix 27/27 on the temporary cluster, quick benchmarks within budgets. Auditors' probes re-run; remaining FAIL lines are intended-behaviour changes listed at the end of ISSUES.md.
Documented-only items: F-PL-08 (D22), F-CD-04 residual template size, F-CD-07 backend request timing not benchmarked, F-AP-10 core cannot check interface compatibility of overrides at runtime.

## Modified files
- (Phase A) work/v05/*.md, .gitignore, package-lock.json

## Next steps
1. Repo hygiene: drop committed dist, add lockfile, bump to 0.5.0.
2. Probe tests of v0.4 kernel against v0.5 requirements (record failures in ISSUES.md).
3. Hyla-mini skeleton: FS + PG repositories, HTTP page, static build.

## Resources created by this task (cleanup list)
- work/pg/ (temporary PostgreSQL cluster data, gitignored) — stopped/removed by scripts/pg-test-cluster.mjs stop
- work/release/ (archives, unpack dirs)

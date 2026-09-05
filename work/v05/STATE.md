# Syna v0.5 + Hyla-mini — STATE

## Current phase
Phase C started early for the kernel (v0.5 core compiled, 88 migrated tests pass, 4 demos run).
Phase B (Hyla-mini vertical path) in progress: domain skeleton written; data adapters + app layers next.

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
(none yet — see ISSUES.md as they are recorded)

## Modified files
- (Phase A) work/v05/*.md, .gitignore, package-lock.json

## Next steps
1. Repo hygiene: drop committed dist, add lockfile, bump to 0.5.0.
2. Probe tests of v0.4 kernel against v0.5 requirements (record failures in ISSUES.md).
3. Hyla-mini skeleton: FS + PG repositories, HTTP page, static build.

## Resources created by this task (cleanup list)
- work/pg/ (temporary PostgreSQL cluster data, gitignored) — stopped/removed by scripts/pg-test-cluster.mjs stop
- work/release/ (archives, unpack dirs)

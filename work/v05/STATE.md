# Syna v0.5 + Hyla-mini — STATE

## Current phase
Phase F: release gate. `node scripts/verify-v05.mjs --release` COMPLETE (exit 0) at commit f9a3b35: 30 steps, 506/506 tests, 0 skipped, fingerprint 68119800…43a79; docs/VALIDATION.md regenerated from that manifest.
Release-gate history (2026-09-05): run 1 PARTIAL — archive scan rejected two strings in the archived cache-delivery audit report (reworded, c9006e4); run 2 PARTIAL — H10 backpressure test raced on concurrent config reads (test fixed, f9a3b35, I-49); run 3 COMPLETE.
Next: commit VALIDATION.md + ledgers → final `--release` run on that source (RELEASE_MANIFEST.json) → commit release evidence → session report.

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
- work/release/ (archives, packed tarballs, staging copy syna-v0.5.0-source/; gitignored)
- validation/v0.5-release/ and RELEASE_MANIFEST.json (committed evidence of the final run)
- rebuild directories are created with mkdtemp under the OS temp dir and removed by the orchestrator (none left after the runs)

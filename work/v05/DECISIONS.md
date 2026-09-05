# Decisions (keep / fix / extend / exclude)

| # | Decision | Kind | Why |
|---|----------|------|-----|
| D01 | Keep npm workspaces + add `package-lock.json`; do not switch to pnpm | keep | Baseline uses npm; task forbids gratuitous package-manager churn. |
| D02 | Remove committed `dist/` from git; build outputs are regenerated | fix | Task: old dist must never stand in for new source. |
| D03 | Replace hand-written `semver.ts` with npm `semver` (pinned by lockfile) | fix | K06 / §11: do not hand-roll SemVer. |
| D04 | Remove setup barrier, ALS-based strong loads, `trackStrongOperation`, activation transactions | fix | K07/K02: plain Promises; no Prepared / fake Ready. |
| D05 | Dependency refs given to `setup()` carry their requester attempt explicitly (no AsyncLocalStorage) | fix | ALS may only trace origin; explicit refs are more precise and need no async_hooks ambient typing. |
| D06 | Wait cycles are never failed immediately; a configurable initialization deadline reports `INITIALIZATION_TIMEOUT` with observed pending loads and a *suspected* load-call cycle | fix | K07/R04. |
| D07 | `InputRef.read()` returns the raw payload synchronously; `InputRef.load()` kept as deprecated `Promise<Awaited<T>>`; `loadAll()` accepts Service-like refs only | extend | §6 / K05 / R05. |
| D08 | BoundEntry.enter/run require a Ready anchor; otherwise `OWNER_NOT_READY` (catchable) | fix | K02/K10/H13. |
| D09 | Private realm = transitive private closure of the owning Service revision; exact and range resolve identically inside it; Contract discovery stays public | fix | K10/R07. |
| D10 | Lineage anchors persist in the plan (anchor slot + its dependency slots); re-appearance reuses the anchored slot only when every dependency slot is identical, else `LINEAGE_UNIQUENESS_CONFLICT` with chain | fix | K04/R13; no general history search. |
| D11 | `override(Source, Fake)` compiles into an internal `CompiledService` (source nominal identity + Fake executable manifest). eager/provides/metadata/uniqueWithin from Source; requires/setup/failure from Fake | keep+fix | K11; decision table in docs/SEMANTIC_CHANGES_V05.md. |
| D12 | `explain()` added; `check()` kept. Both plan only. Report distinguishes inherited/new/forked with cause paths, arguments vs shape coverage | extend | K12/H12. |
| D13 | `C.selector` kept as minimal compatibility (deprecated); `C.all` is the recommended same-Env collection | keep | §6. |
| D14 | Real PostgreSQL via `pg`; tests run against a temporary cluster from Homebrew binaries (`scripts/pg-test-cluster.mjs`), or `SYNA_TEST_PG_URL` | keep | H02; Docker daemon not running on this host. |
| D15 | Hyla-mini lives in `apps/hyla-mini` (one package, internal folders); old v0.4 demo packages kept and ported | keep | §8 “no dozens of wrapper layers”. |

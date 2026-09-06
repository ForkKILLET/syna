# Syna v0.6 API consolidation — state

Task book: `SYNA_V06_API_EXECUTION_PROMPT.md`. Baseline: 0.5.0 at commit 4a67b99 (release gate COMPLETE, see `work/v05/STATE.md`).

## Phase A — inventory and README-first (done)

- A1 `scripts/api-inventory.mjs` (TypeScript compiler API over `packages/core/src/index.ts`) → `work/v06/API_INVENTORY_BEFORE.md` + `.json`: 104 exports (11 values, 93 types), 249 interface/class members, 42 union members (23 `SynaErrorCode` + `DiagnosticCode`), 5 `@deprecated` items. Re-run: `node scripts/api-inventory.mjs --out … --json …`; diff: `node scripts/api-inventory.mjs --diff before.json after.json --out …`.
- A2 `work/v06/RENAME_PLAN.md`: every §3 item with files, tests, docs and its §2 reason; five findings (F1–F5) recorded before implementation: `persistentRef` stays (`ImplementationCandidate.ref` exists), `serviceRange` takes a revision and `ServiceFamily.range()` would be a new dependency form, `CONSTRAINT_VIOLATION` has four throw sites (pure rename), `UNKNOWN_ERROR` is already diagnostic-only, `reuse` joins `scope` as a reserved Entry parameter id.
- A3 `work/v06/README_EXAMPLE.md`: the three README blocks (`src/greeter.ts`, `src/conversation.ts`, `src/main.ts`) in the v0.6 names, no explanatory comments, expected output recorded; goes into both READMEs in Phase D and runs as `scripts/tests/readme-example.test.mjs` in Phase F.
- Baselines recorded on 0.5.0 before any rename:
  - `packages/core/tests/v06-snapshots.test.mjs` + `packages/core/tests/snapshots/v05-explain-inspect.json` (check/explain/inspect/catalog/error snapshots of one fixed world; `RENAMED` mapping is the only permitted change per rename commit).
  - `benchmarks/results-v0.5.0-baseline-same-machine.json`: element-wise median of 7 runs of `benchmarks/v0.5-planning.mjs` (Node v26.0.0, Apple M4 Pro, darwin arm64). `scripts/benchmark-compare.mjs compare --baseline … --runs 7` enforces ±10 % on every p50/p95 and `perOperationMs` and equality of all plan-cache counters and shape counts; two disjoint subsets of the 7 baseline runs differ by at most 2.9 % on those values.
  - `work/v06/ANY_BASELINE.json` (204 `any` keywords in 84 files) + `scripts/tests/any-count.test.mjs`.

## Phase B — renames (pending)

R1 … R6, one commit each.

## Phase C — deletions, merges, type strengthening (pending)

## Phase D — applications, benchmarks, scripts, docs (pending)

## Phase E — stability, migration, deferred, changelog, version (pending)

## Phase F — verification and release gate (pending)

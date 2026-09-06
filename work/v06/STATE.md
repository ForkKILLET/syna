# Syna v0.6 API consolidation — state

Task book: `SYNA_V06_API_EXECUTION_PROMPT.md`. Baseline: 0.5.0 at commit 4a67b99 (release gate COMPLETE, see `work/v05/STATE.md`).

## Phase A — inventory and README-first (done)

- A1 `scripts/api-inventory.mjs` (TypeScript compiler API over `packages/core/src/index.ts`) → `work/v06/API_INVENTORY_BEFORE.md` + `.json`: 104 exports (11 values, 93 types), 249 interface/class members, 42 union members (23 `SynaErrorCode` + `DiagnosticCode`), 5 `@deprecated` items. Re-run: `node scripts/api-inventory.mjs --out … --json …`; diff: `node scripts/api-inventory.mjs --diff before.json after.json --out …`.
- A2 `work/v06/RENAME_PLAN.md`: every §3 item with files, tests, docs and its §2 reason; five findings (F1–F5) recorded before implementation: `persistentRef` stays (`ImplementationCandidate.ref` exists), `serviceRange` takes a revision and `ServiceFamily.range()` would be a new dependency form, `CONSTRAINT_VIOLATION` has four throw sites (pure rename), `UNKNOWN_ERROR` is already diagnostic-only, `reuse` joins `scope` as a reserved Entry parameter id.
- A3 `work/v06/README_EXAMPLE.md`: the three README blocks (`src/greeter.ts`, `src/conversation.ts`, `src/main.ts`) in the v0.6 names, no explanatory comments, expected output recorded; goes into both READMEs in Phase D and runs as `scripts/tests/readme-example.test.mjs` in Phase F.
- Baselines recorded on 0.5.0 before any rename:
  - `packages/core/tests/v06-snapshots.test.mjs` + `packages/core/tests/snapshots/v05-explain-inspect.json` (check/explain/inspect/catalog/error snapshots of one fixed world; `RENAMED` mapping is the only permitted change per rename commit).
  - `benchmarks/results-v0.5.0-baseline-same-machine.json`: element-wise median of 7 runs of `benchmarks/v0.5-planning.mjs` (Node v26.0.0, Apple M4 Pro, darwin arm64). `scripts/benchmark-compare.mjs compare --baseline … --runs 7` enforces ±10 % on every p50/p95 and `perOperationMs` and equality of all plan-cache counters and shape counts; two disjoint subsets of the 7 baseline runs differ by at most 2.9 % on those values.
  - `work/v06/ANY_BASELINE.json` (204 `any` keywords in 84 files) + `scripts/tests/any-count.test.mjs`. Moved in Phase F to `scripts/any-baseline-v0.5.0.json` so the release gate can re-check it inside the rebuilt archive (`work/` is never archived).

## Phase B — renames (done)

One commit per item; each contains the new name, the deprecated alias, a migration-equivalence test (`packages/core/tests/v06-r<n>-*.test.mjs`), type tests (`packages/core/type-tests/api.ts`) and the docs. Aliases are non-enumerable getters (`descriptor.scope`, `ref.implementationId`), a prototype getter (`RuntimePolicyContext.site`), a forwarder (`env.bind` → `env.anchor`) or type aliases; every alias is listed in `scripts/tests/deprecations.test.mjs` (EXPECTED), which also fails on any `@deprecated` not in that list.

| # | Commit | Summary |
|---|---|---|
| R1 | 9ec421a | `scope` → `reuse` (definition, descriptor, call-time options record `{ reuse }`), `DeriveOptions` → `ReuseConstraints`, `ScopeTarget` → `ReuseTarget`; `reuse` joins `scope` as a reserved parameter id |
| R2 | 1ca9a7e | `env.bind` → `env.anchor`, `BoundEntry` → `AnchoredEntry` |
| R3 | 62ad4fc | `SynaRuntime` → `Runtime` |
| R4 | 341a69e | `DependencyRef` → `ServiceRef` |
| R5 | 75480ed | `PersistentImplementationRef` → `ImplementationRef`, persisted key `implementationId` → `familyId` (`catalog.resolve`/`set.resolve` accept both; Hyla-mini normalizes stored refs on read: `normalizeStoredImplementationRef`) |
| R6 | 3cdd1b2 | `RuntimePolicyContext.site` → `dependencySite` |

## Phase C — deletions, merges, type strengthening (done)

| # | Commit | Summary |
|---|---|---|
| D2 | 86427c5 | `InputRef.load()` removed (`read()` only; `loadAll()` rejects Input refs structurally) |
| D1 | 1c09234 | `ServiceRef.preload()` removed (its body was an un-awaited `load()` with a swallowing catch) |
| D3 | d09b62f | `C.selector` / `ImplementationSelector` / `ImplementationLease` / selector plan nodes / `UNAVAILABLE_IMPLEMENTATION` removed; `C.all` is the only collection form (`ImplementationCandidate.availability` kept, always `available` → DEFERRED) |
| D4 | 351c7d2 | `serviceRange()` removed (`Revision.range()` only) |
| M1 | 99273f3 | `limits: { setupDeadlineMs, disposalGraceMs, planningBudget, planCacheEntries }` replaces the four option records (deprecated aliases kept; both forms → TypeError); defaults locked by `v06-m1-limits.test.mjs` (source, d.ts doc, API_REFERENCE, `inspect().planCache.maxEntries`) |
| M2 | 5419a70 | `EntryParameters<E>` (declared map) vs `EntryArguments<E>` (call values); `EntryParameter*`/`EntryRunArguments` no longer exported |
| M3 | 105ed40 | `CONSTRAINT_VIOLATION` → `FRESH_CONSTRAINT_FAILED` (four throw sites, details unchanged; no alias, the old code was never thrown by 0.6) |
| T2 | d2590a6 | phantom fields unified as `__type`; `kind` separates descriptor kinds |
| T1 | (this commit) | `SynaError<Code>` union discriminated by `code`, `SynaErrorDetails` per-code map, generic `isSynaError`/`asSynaError`; API_REFERENCE per-code details table; `v06-t1-errors.test.mjs` pins produced shapes, d.ts and table against the 22 codes |

Snapshots (`v06-snapshots.test.mjs`) stayed identical apart from the RENAMED mapping (`implementationId` → `familyId` inside persistent refs, `CONSTRAINT_VIOLATION` → `FRESH_CONSTRAINT_FAILED`, the `pickerRefJson` string); the any-count stayed at or under the baseline in every commit.

## Phase D — applications, benchmarks, scripts, docs (done: 97b0917)

- Hyla-mini (`Runtime` type, preflight message, `syna-v05-compat` markers on the stored-reference compatibility), the benchmark case function/comment (the result label `bound-entry-…` stays for baseline comparability, DEFERRED N4), `scripts/validation-doc.mjs`, the core test fixtures that spelled `selector`/`scope`/`implementationId`.
- `scripts/tests/no-old-names.test.mjs`: scans apps, benchmarks, scripts, `.github`, every non-core package and the core test suites for the 0.5 names; exemptions only by `syna-v05-compat` marker (list asserted verbatim); the current docs may spell an old name only in the deprecation table or on a line that explains the 0.5 → 0.6 change.
- README.md / README.zh-CN.md: "Syna in one screen" / "一屏示例" = package.json + the three files of `work/v06/README_EXAMPLE.md`, no comments, followed by the output; `scripts/tests/readme-example.test.mjs` compiles and runs them in a scratch package (workspace TypeScript, `@syna/tsconfig/node-app.json`) and asserts the output. The Phase A record gained the package.json block; the recorded output was corrected (fork labels are node ids: `greeter/input/audience/v1`, `greeter@1.0.0`).

## Phase E — stability, migration, deferred, changelog, version (done)

- `docs/API_STABILITY.md` (frozen surface = §3.5 + the new names; one-minor deprecation policy with every alias and its 0.7.0 removal; six naming guidelines), `docs/MIGRATION_V05_TO_V06.md` (every R/D/M/T row with a reason number; R5 persisted-key section), `docs/DEFERRED.md` (命名 N1–N7, 语义 S1–S10), `CHANGELOG.md` 0.6.0.
- Version 0.6.0 in every manifest and in `package-lock.json` (npm confirms the lock is up to date); workspace name `syna-v0.6-workspace`; version labels in both READMEs, `packages/core/README.md`, ARCHITECTURE, API_REFERENCE, SEMANTIC_MODEL, HYLA_MINI.

## Phase F — verification and release gate (pending)

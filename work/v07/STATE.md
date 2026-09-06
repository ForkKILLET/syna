# Syna v0.7 — working state

Task book: `SYNA_V07_EXECUTION_PROMPT.md` (untracked at the workspace root; never committed). Baseline 0.6.0 = commit 582c93a.

## Phase A — proposal (2026-09-06) — APPROVED

- `work/v07/API_INVENTORY_BEFORE.{md,json}` regenerated on 582c93a: 387 items, 23 `@deprecated`, identical to `work/v06/API_INVENTORY_AFTER.json` except the `commit` field.
- `work/v07/PROPOSAL.md` (commit 2c2de67): deletion inventory (§1), S1 state machine (§2), S2 state + `dispose()` contract, recommendation (i) (§3), S6 table (§4), S7 tables (§5), S8 (§6), S10 (§7), permanent `implementationId` key + event (§8), snapshot impact (§9), test-withdrawal register (§10), phases/gate (§11), Q1–Q11 (§12).
- Review: the user answered "继续" — the proposal is approved with every §12 recommendation unchanged (Q1 TypeError for a call-time `scope` key; Q2 delete `AvailableImplementationCandidate`; Q3 overdue attempts listed as `timed-out`; Q4 `ENTRY_ACTIVATION_FAILED` keeps its shape; Q5 summary event `attempts-outstanding`; Q6 delete `UNSETTLED_ATTEMPT`; Q7 unreachable `INVALID_ENV_STATE` sites become internal `Error`s; Q8 `CandidateRef.revisionKey` → `INVALID_DESCRIPTOR`; Q9 `asSynaError` details = site details + `cause: { name, message }`; Q10 event `legacy-implementation-ref`; Q11 waiter window per attempt; S2 option (i); S7 codes `ENV_CLOSED` / `RUNTIME_CLOSED` / `SLOT_NOT_LOADABLE` / `LIFECYCLE_MISUSE`).

## Phase B — deletions (2026-09-06)

### B1 — §2.1: the 23 aliases and the 0.5 call form — DONE (this commit)

- Source: `descriptors.ts` (types, `EntryCallArguments` / `EntryRunCallArguments` without the scoped branches, `RuntimeEvent` gains `legacy-implementation-ref`), `index.ts` (10 exports gone), `definition.ts` (`scope` at definition time → `TypeError`; `LEGACY_FAMILY_KEY` read permanently, `parse()` marks refs from old-key documents with a non-enumerable Symbol, `isLegacyImplementationRef()` / `normalizeImplementationRef()`), `runtime.ts` (`scope` / `reuse` inside the parameter record → `TypeError`; the four nested option records → `TypeError` naming `limits.<key>`; `EnvImpl.bind` gone), `runtime-model.ts` (`PolicyContext` without `site`), `implementation-directory.ts` (`familyOf(ref, site)` emits the event once per read; `candidatesForFamily`), `entry-planner.ts` (Binding path reads through `familyOf`).
- Inventory: 364 items, 0 `@deprecated`; diff vs the 0.6.0 record = exactly the 23 items (`scripts/tests/api-inventory.test.mjs` asserts equality, not containment). `any` count 181 (baseline 204; per-file check green after dropping an explicit `<any>` from `familyOf`).
- Tests: deleted `v06-r1` … `v06-r6`, `v06-m1-limits` (registered for `SEMANTIC_CHANGES_V07` §撤回); added `v07-expired-forms.test.mjs` (12 tests: declarations, definition, call shapes, derive, anchored entries, Runtime surface, refs, policy context, locked defaults, each limit key, refused records) and `v07-legacy-implementation-key.test.mjs` (4 tests: `to()`, `parse()`, every Runtime read path + event, diagnostics-only). `type-tests/api.ts`: every expired form `@ts-expect-error` (file-level `syna-v05-compat` marker kept, since it spells them all). `deprecations.test.mjs`: empty register, asserts 0. `no-old-names.test.mjs`: 0.7 wording, exemption list = 5 files, new scan of `packages/core/src` for the deleted public names.
- Docs: `API_REFERENCE` (ref key permanent + event, `scope` refusal, `SynaRuntime` / `context.site` / nested records removed, "Deprecated in 0.6, removed in 0.7.0" collapsed to one paragraph), `API_STABILITY` (policy: empty register, permanent R5 key), `DEFERRED` N5, `PLUGIN_AUTHORING` recipe key, `packages/core/README`, `MIGRATION_V05_TO_V06` (history note: the key is permanent), new `docs/MIGRATION_V06_TO_V07.md` (§1 table of 23 + call form, §2 permanent key, §3/§4 placeholders for C/D/E, §5 steps), `CHANGELOG` 0.7.0 section started. Hyla-mini comments: the 0.5 key is permanent data compatibility, never written.
- Suites: `npm test` 185/185, `npm run typecheck` 0, `npm run test:scripts` 21/21, `npm run test:app` 122+14 / 0 failures (`work/v05/working-set.json` restored).

### B2 — §2.2: selector remnants — NEXT

Delete `CandidateAvailability`, `ImplementationCandidate.availability` (producer: `CandidateIndex` constructor), `AvailableImplementationCandidate` (Q2); `DEFERRED` N2 removed; `no-old-names` patterns; inventory lists (`DELETED_07` / `DELETED_MEMBERS_07`); docs mentioning selector / lease / pre-check / availability rewritten.

## Later phases

C (S6, S7, S8, S10 — one commit each with per-site tests and the API_REFERENCE error table), D (S1), E (S2), F (docs: `SEMANTIC_CHANGES_V07`, `MIGRATION_V06_TO_V07` §3/§4, `API_STABILITY` 1.0 candidate, `DEFERRED`, `CHANGELOG`, `SEMANTIC_MODEL` §11/§13, READMEs, version 0.7.0), G (`scripts/verify-v07.mjs`, benchmark vs 582c93a, any baseline 0.6.0, two-run gate, evidence report) — per `PROPOSAL.md` §11.

Reproduce the inventory: `node scripts/api-inventory.mjs --out work/v07/API_INVENTORY_BEFORE.md --json work/v07/API_INVENTORY_BEFORE.json` (on 582c93a). Current: `node scripts/api-inventory.mjs --json <file>`; per-file `any`: `node scripts/any-count.mjs --check scripts/any-baseline-v0.5.0.json`.

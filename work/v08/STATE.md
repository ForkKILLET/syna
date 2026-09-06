# Syna v0.8 — working state

Task book: `SYNA_V08_EXECUTION_PROMPT.md` (untracked at the workspace root with `SYNA_V08_GOAL.txt`; never committed). Baseline 0.7.0 = commit 72f1991 (the final 0.7 evidence commit). This is the last rename before 1.0: names only, no aliases, no old keys, no semantic change (§2.0).

## Phase A — the list (2026-09-06) — DONE (this commit); report point, continued without pause

- `work/v08/API_INVENTORY_BEFORE.{md,json}` regenerated on 72f1991: 367 items, 0 `@deprecated`, identical to `work/v07/API_INVENTORY_AFTER.json` apart from the commit field.
- `work/v08/census.mjs` → `work/v08/CENSUS.md`: for every §2 item the inventory entries it touches and every file that spells the old name (core src / core tests / consumers / docs, with line numbers).
- `work/v08/RENAME_TABLE.md`: old → new → category → file counts per area → codemod edits; the complete `*Key` list (public: `parentActiveRevisionKeys` = F2, `selectedKey` = F3; internal `*Key` identifiers unchanged); the five decisions (F9 `parse()` error class → `INVALID_DESCRIPTOR` with one new `problem` token `malformed-implementation-ref`; F15 covers the two details fields; benchmark record keys normalized in `benchmark-compare.mjs`; Hyla-mini's own names stay; the hand-done list); the out-of-table findings for `DEFERRED.md` "命名（2.0）".
- `scripts/codemod-v08.mjs` (TypeScript-program driven, type-aware, idempotent, `--dry-run` / `--verbose` / `--json`, exit 2 while sites that need a hand remain). Trial on Hyla-mini: 85 edits in 15 files, second run 0 edits; 9 hand sites = the old-key code deleted in Phase C. Dry run over every consumer: 525 edits in 52 files, 20 hand sites (all old-key code). Reports: `work/v08/codemod-trial-hyla-mini.json`, `work/v08/codemod-dry-run-all.json`.

## Phase B — core renames (§2.1 → §2.2 → §2.3 → §2.4, one commit each) — NEXT

Each commit syncs `SynaErrorDetails`, the event types, the inspection types and `packages/core/type-tests/api.ts`; `packages/core/tests` stay on the old names until Phase C (the core suite is red between B1 and C by design; `npm run typecheck` and the type tests are the per-commit check).

- B1 §2.1: T1–T7 (`Env`, `Entry`, `ImplementationRecord`, `NodePlacement`, `InputValue`, `SlotState` exported, `UniquenessPolicy = 'lineage'` with `uniqueWithin?`).
- B2 §2.2: F1–F19 (incl. the deletion of the old-key read path and `parse()` → `INVALID_DESCRIPTOR`).
- B3 §2.3: D1–D10 (incl. the typed `state`s and the event renames / deletion).
- B4 §2.4: S1 `derive(options)`, S2 `revisions(family)`; the `api-inventory.mjs --diff` doc-only bucket (§2.6) and the `DeadlineQueue` tests.

## Phase C — consumers by codemod — PLANNED

`node scripts/codemod-v08.mjs` over the defaults; then by hand: delete the old-key code and tests, rewrite the snapshot mapping and the S2 literal, the key-list assertions, the F9 `INVALID_DESCRIPTOR` test, `no-old-names` (every 0.8 old name, code, key and event), `api-inventory.test.mjs` against `work/v08/API_INVENTORY_BEFORE.json`, `benchmark-compare.mjs` record normalization, `package.json` scripts. Every hand edit is listed here when done.

## Phase D — documents — PLANNED

`docs/MIGRATION_V07_TO_V08.md`, `API_STABILITY.md` (the three sentences; "the last rename"), `DEFERRED.md` "命名（2.0）", `CHANGELOG.md`, `SEMANTIC_MODEL.md` (§3 no "strong", lowercase code-font states, §7 pinned, §11 load timeout, `Env` / `Entry`), `ARCHITECTURE.md` (`DeadlineQueue`), `PACKAGE_AUTHORING.md` (`loadTimeoutMs` section), `docs/GLOSSARY.md`, `API_REFERENCE.md`, READMEs, `HYLA_MINI.md`, `PLUGIN_AUTHORING.md`; version 0.8.0.

## Phase E — verification and delivery — PLANNED

`scripts/verify-v08.mjs` (0.7.0 baselines: commit 72f1991, `benchmarks/results-v0.7.0-baseline-same-machine.json` = the 0.7.0 side of the final 0.7 run, `scripts/any-baseline-v0.7.0.json`, `work/v08/API_INVENTORY_BEFORE.json`, archive `syna-v0.8.0-source`, `validation/v0.8-release`), CI workflow, all suites + PostgreSQL matrix, the two-run release protocol, the final report (gate summary, archive hashes, inventory diff vs RENAME_TABLE).

## Reproduce

- Inventory: `node scripts/api-inventory.mjs --out work/v08/API_INVENTORY_BEFORE.md --json work/v08/API_INVENTORY_BEFORE.json` (on 72f1991).
- Census: `node work/v08/census.mjs --out work/v08/CENSUS.md`.
- Codemod trial: `node scripts/codemod-v08.mjs --json work/v08/codemod-trial-hyla-mini.json apps/hyla-mini && node scripts/codemod-v08.mjs apps/hyla-mini` (second run: 0 edits), then `git checkout -- apps/hyla-mini`; every consumer: `node scripts/codemod-v08.mjs --dry-run --json work/v08/codemod-dry-run-all.json`.

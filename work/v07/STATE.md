# Syna v0.7 — working state

Task book: `SYNA_V07_EXECUTION_PROMPT.md` (untracked at the workspace root; never committed). Baseline 0.6.0 = commit 582c93a.

## Phase A — proposal (2026-09-06) — WAITING FOR REVIEW

- `work/v07/API_INVENTORY_BEFORE.{md,json}` regenerated on 582c93a: 387 items, 23 `@deprecated`, identical to `work/v06/API_INVENTORY_AFTER.json` except the `commit` field.
- `work/v07/PROPOSAL.md` written: deletion inventory (§1), S1 state machine and waiter/attempt separation (§2), S2 state + `dispose()` contract with recommendation (i) (§3), S6 table (§4), S7 16-site `INVALID_ENV_STATE` → 4 codes and the 28-site `INVALID_DESCRIPTOR` details table (§5), S8 three shapes (§6), S10 typing (§7), permanent `implementationId` key + diagnostics event (§8), planner/snapshot impact (§9: verbatim; only the S6 rename and the S2 `abandonedAttempts` field enter the snapshot mapping), the test-withdrawal register (§10), phases/gate plan (§11) and the open questions Q1–Q11 with recommendations (§12).
- Nothing in `packages/`, `apps/`, `scripts/` or `docs/` has been changed.

Next: review of `PROPOSAL.md`. On approval (with any changes to the Q1–Q11 recommendations) Phase B starts: §2.1 deletions (one commit), §2.2 remnants (one commit).

Reproduce the inventory: `node scripts/api-inventory.mjs --out work/v07/API_INVENTORY_BEFORE.md --json work/v07/API_INVENTORY_BEFORE.json`.

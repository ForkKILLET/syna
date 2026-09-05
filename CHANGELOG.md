# Changelog

## 0.5.0

Semantics (see docs/SEMANTIC_CHANGES_V05.md and docs/MIGRATION_V04_TO_V05.md):

- `load()` is a plain Promise. Removed the setup completion barrier, AsyncLocalStorage strong-load tracking and the immediate `CIRCULAR_MATERIALIZATION` verdict. Pending waits are reported by a configurable initialization deadline (`INITIALIZATION_TIMEOUT`) with observed pending loads and a suspected load-call cycle as an observation, not a proof.
- Attempts and waiters: one attempt per slot at a time; `load({ signal })` ends only the caller's wait (`LOAD_CANCELLED`); timed-out attempts block overlapping attempts (`UNSETTLED_ATTEMPT`); late results are discarded, cleaned up and reported through `diagnostics.onEvent`; disposal reports never-settling attempts instead of claiming a clean close.
- Removed activation transactions and fake-Ready children. A Service-owned `BoundEntry` requires a Ready owner (`OWNER_NOT_READY`); worker worlds are started by the host after the root is Ready.
- Parent-only canonical-slot reuse with a fixed point over the reverse dependency graph; persistent lineage anchors re-attach only when every dependency slot matches, otherwise `LINEAGE_UNIQUENESS_CONFLICT` with the full chain. A brute-force reference planner is checked against production on seeded random graphs.
- `InputRef.read()` returns the payload as provided (Promise, thenable, function, undefined preserved); `InputRef.load()` deprecated. `loadAll()` accepts Service refs only.
- Private resolution realms: a Service-owned Entry resolves exact and range roots inside the owner's exact closure; Contract discovery stays public.
- `override(Source, Fake)` compiles into an internal `CompiledService` (Source identity, Fake executable manifest) used by every resolution path; decision table documented.
- `explain()`: inherited/new/forked counts for Services, Inputs and synthetic nodes, eager-to-start, choices, missing parameters and per-node cause paths. Planning search budget (`PLANNING_BUDGET_EXCEEDED`).
- `C.all` is the recommended same-Env collection; `C.selector` is a deprecated minimal compatibility surface.
- npm `semver` replaces the hand-written parser; ranges are validated at definition time; admitted prereleases participate in ranges.

Tooling and delivery:

- `scripts/verify-v05.mjs --dev|--release` acceptance orchestrator with source fingerprint, per-step logs, TAP counts, zero-skip enforcement, archive + clean-directory rebuild + consumer smoke.
- `scripts/pg-test-cluster.mjs` temporary PostgreSQL cluster for real-database tests.
- `benchmarks/v0.5-planning.mjs` with machine-readable budgets and a same-machine v0.4 baseline run.
- Hyla-mini application (`apps/hyla-mini`) with real PostgreSQL and filesystem adapters, HTTP and static matrix, recipes, tenants, auth, SiteEnv working set, preflight budgets, worker and CLI.

## 0.4.0

- See git history (`395e089`) for the imported v0.4.0 reference implementation.

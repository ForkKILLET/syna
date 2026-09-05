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

Fixes from the independent audits (docs/AUDIT.md; regression tests `packages/core/tests/v05-audit-lifecycle.test.mjs`, `v05-audit-planning.test.mjs`, `apps/hyla-mini/tests/audit-app.test.mjs`):

- Core lifecycle: disposal is bounded by `disposal.graceMs` for running attempts too (no more waiting out a 30 s or infinite deadline); the stop signal is broadcast to the whole subtree before anything is awaited and sibling subtrees close concurrently; an Env with an abandoned attempt stays `disposing` until the late result is cleaned up; `onDispose()` registered after a deadline is honoured; disposal order follows dependencies through never-started slots; every `load()` caller gets its own Promise; an already-aborted `signal` starts nothing.
- Core planning: `explain()` lists missing Inputs/Bindings required deep in the graph; candidate-independent failures keep their own code instead of `UNSATISFIABLE_TOPOLOGY`; plan-template keys carry a digest of the parent signature (verified on hit) instead of the whole signature.
- Hyla-mini: SiteEnvs rotated during creation are closed, `invalidate()` uses a per-tenant generation, acquire retries are time-bounded; page cache keyed by a store content version; HTTP handlers answer 400 to unparsable targets and never echo internal errors (`onError` hook); fast-failing creations share one attempt (`SITE_CREATION_BACKOFF`); pool ended once on failed setup; static builder only removes files from its own manifest and refuses foreign directories; worker `stop()` during `start()`; authenticator interface checked at site creation; startup touches the backend; `close()` returns the unreleased-lease report; domain claims validated at save time, conflicts disable only the host.
- Orchestrator: `close` event, SIGTERM before SIGKILL, `todo`/`cancelled` count as not run, `<root>`-relative commands, provenance captured first, working-set written into the run directory, release hashes in `validation/v0.5-release/SHA256SUMS.txt`.

Tooling and delivery:

- `scripts/verify-v05.mjs --dev|--release` acceptance orchestrator with source fingerprint, per-step logs, TAP counts, zero-skip enforcement, archive + clean-directory rebuild + consumer smoke.
- `scripts/pg-test-cluster.mjs` temporary PostgreSQL cluster for real-database tests.
- `benchmarks/v0.5-planning.mjs` with machine-readable budgets and a same-machine v0.4 baseline run.
- Hyla-mini application (`apps/hyla-mini`) with real PostgreSQL and filesystem adapters, HTTP and static matrix, recipes, tenants, auth, SiteEnv working set, preflight budgets, worker and CLI.

## 0.4.0

- See git history (`395e089`) for the imported v0.4.0 reference implementation.

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

Fixes from the third review round (docs/AUDIT.md "Third review round"; regression tests `packages/core/tests/v05-review-lifecycle.test.mjs` R-5, `v05-cache-cleanup.test.mjs` R17 anchors, `v05-realms-override.test.mjs`, `v05-explain.test.mjs`):

- Core: a `Family.range()` reference carries its origin revision, so a Family referenced only by range resolves in the owner's private realm; a range loads the origin's Contract view (`ProvidedShape<Provides>`) and only revisions providing those Contracts are candidates (`INCOMPATIBLE_IMPLEMENTATION` otherwise). Plan templates are keyed by the lineage anchors (a stale hit is evicted and re-solved), so plans no longer depend on which lineage warmed the cache. A setup deadline that fires during the disposal grace no longer hides the attempt: the close reports `UNSETTLED_ATTEMPT` and the Env stays `disposing` until it settles. `check()`/`explain()` consume no Env id and `inspect().definitions` exposes the (bounded) registry sizes. Two physical copies of a revision with different `setup` bodies are a `DUPLICATE_DEFINITION` instead of first-wins. `preload()` is deprecated.

Fixes from the second review round (docs/AUDIT.md "Second review round"; regression tests `packages/core/tests/v05-review-lifecycle.test.mjs`, `apps/hyla-mini/tests/review-app.test.mjs`):

- Core: a failed rollback is final (`ROLLBACK_FAILED` on every later `load()`, also under `retry-on-next-load`); a caught `LOAD_CANCELLED` never leaves an unhandled rejection behind; the bounded close detaches the Env from the tree and the Runtime's registries (its parent no longer waits for it, `inspect()` no longer counts it) while its state stays `disposing` until the abandoned attempts settle; those attempts are held weakly in `inspect().unsettledAttempts`, closed as `attempt-unreachable` when their setup Promise is garbage-collected, and reported again by `runtime.dispose()`; `UNSETTLED_ATTEMPT` names the dependency slots an abandoned attempt may still use (closed in the normal order: the model has no revocation, documented as inherent).
- Hyla-mini: a SiteEnv whose creation fails after it was entered is closed; a closing SiteEnv keeps its unit of capacity until its close settles (`disposing` records, FIFO grants); the page cache reads the content version before the content; background closes never reject (`onDisposalError` hook, `stats().disposalFailures`); `close()` returns `{ unreleasedLeases, unsettledAttempts, errors }` instead of rejecting.

Tooling and delivery:

- `scripts/verify-v05.mjs --dev|--release` acceptance orchestrator with source fingerprint, per-step logs, TAP counts, zero-skip enforcement, archive + clean-directory rebuild + consumer smoke.
- `scripts/pg-test-cluster.mjs` temporary PostgreSQL cluster for real-database tests.
- `benchmarks/v0.5-planning.mjs` with machine-readable budgets and a same-machine v0.4 baseline run.
- Hyla-mini application (`apps/hyla-mini`) with real PostgreSQL and filesystem adapters, HTTP and static matrix, recipes, tenants, auth, SiteEnv working set, preflight budgets, worker and CLI.

## 0.4.0

- See git history (`de1d441`) for the imported v0.4.0 reference implementation.

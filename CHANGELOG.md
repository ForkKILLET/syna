# Changelog

## 0.4.0

- Split the core into immutable definition registry, resolution realms, graph builder, entry planner, materializer, bounded plan cache, and implementation-directory modules.
- Made selector candidate Entry identities independent from Env and slot ids; repeated request-shaped selectors now reuse plan templates.
- Bounded the plan-template cache with deterministic LRU eviction and exposed hit/miss/eviction statistics.
- Defined `DependencyRef.load()` as a strong setup dependency and added explicit non-blocking `DependencyRef.preload()`.
- Replaced heuristic Promise-wait inference with a setup materialization barrier and exact strong wait-for edges.
- Made retry/backoff abort-aware and added opt-in `retry-on-next-load` recovery after an exhausted setup sequence.
- Reworked testing replacement as construction-time definition `override()`, preserving the source Service's public nominal identity across exact dependencies, Contracts, selectors, strong sets, persistent refs, and scope constraints.
- Added explicit private resolution realms for Service-owned Entries without exposing private roots to public Entries or Contract discovery.
- Allowed owner-bound Entries to participate in the enclosing activation transaction, including rollback and cycle detection.
- Renamed Entry external provisions to `parameters`, metadata options to `metadata`/`revisionMetadata`, and lineage uniqueness to `uniqueWithin: 'lineage'`.
- Added `loadAll()`, `ImplementationSelector.open()`, and `Symbol.asyncDispose` support for Runtime, Env, and implementation leases.
- Added topology preflight, selector availability diagnostics, and coherent error/suppression handling.
- Expanded the adversarial suite to 88 runtime tests and added request, selector, Binding, and cache-churn benchmarks.

## 0.3.0

- Introduced the refined package-scoped API and the first executable implementation of the frozen Syna Core Semantic Model v0.

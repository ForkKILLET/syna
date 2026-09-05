# Audit 3 — Syna core: Promise/lifecycle semantics and planning

Independent, adversarial review of `packages/core` (third review round: I-58…I-65, D35…D41) against
`docs/SEMANTIC_MODEL.md`, `docs/API_REFERENCE.md`, `docs/PACKAGE_AUTHORING.md`,
`docs/SEMANTIC_CHANGES_V05.md` and the task book (`SYNA_V05_EXECUTION_PROMPT.md`, K01–K12, R01–R20).

- Repository state: HEAD `32d212a`, clean tree; `packages/core/dist` as built (no rebuild was run).
- Node `v26.0.0` (V8 GC semantics matter for F-CL3-03).
- Baseline: the full core test suite passes, 158/158 (`node --test packages/core/tests`, log kept in the
  session scratchpad).
- Every probe lives in this directory, imports `packages/core/dist/index.js`, prints `PASS`/`FAIL`
  lines and exits 1 on any `FAIL`. `sh run-all.sh` re-runs all of them and writes `RUN-LOG.txt`
  (the raw output of the final run is kept next to this report).

## Scope and method

Read first, trust nothing in comments: `runtime.ts`, `internal/materializer.ts`,
`internal/entry-planner.ts`, `internal/graph-builder.ts`, `internal/definition-compiler.ts`,
`internal/identity.ts`, `internal/implementation-views.ts`, `internal/plan-cache.ts`,
`internal/resolution-realm.ts`, `internal/abort.ts`, `internal/solve-errors.ts`, plus the tests that
claim to cover the third round (`v05-review-lifecycle.test.mjs`, `v05-cache-cleanup.test.mjs`,
`v05-explain.test.mjs`, `v05-definitions.test.mjs`, `v05-attempts.test.mjs`, `hardening.test.mjs`).
For each focus area I wrote down what the documents promise, derived a concrete hypothesis from the
code, and wrote a standalone probe. Hypotheses that held are listed at the end with their probe.
Focus areas from the brief: service ranges carrying an origin / Contract view typing (D35/D36),
plan-template cache keys with lineage anchors (D37), `dispose()` racing a setup deadline inside the
disposal grace (D38), `check()`/`explain()` purity (K12/D39), duplicate definitions with differing
setup bodies (D40/R20), bounded close, the weak unsettled-attempt ledger, cancellation paths.

Rules kept: nothing outside `work/v05/audit-3/core-lifecycle-planning/` was written or modified, no
state-changing git command, no build, no database, no Hyla tests.

## Findings

| id | severity | claim | evidence (file:line) | probe → observed | suggested fix | classification |
|---|---|---|---|---|---|---|
| F-CL3-01 | major | `C.selector` expansion keeps a **module-global** cache of synthetic candidate Entries; the Entry records `requires.implementation = revision.source` of whichever Runtime expanded the selector first. A later Runtime in the same process holding a different physical copy of the same revision key fails with `ENTRY_ACTIVATION_FAILED` ← `DUPLICATE_DEFINITION` (setup body differs) or inherits a spurious "different non-semantic metadata" warning (metadata differs). Runtimes contaminate each other through shared Contract objects. | `packages/core/src/internal/implementation-views.ts:46` (`const candidateEntryCache = new WeakMap<Contract, …>()` at module scope), `:48-72` (`candidateEntry`, `:65` `requires: Object.freeze({ implementation: revision.source })`), `:86-89` (used per node); the synthetic Entry's root site is then checked by `graph-builder.ts:105` → `definition-compiler.ts:121-132` (`compiledExact` → `assertEquivalentRevisionDefinitions`, `identity.ts:114-130`). | `02-selector-cross-runtime-cache.probe.mjs` → 3/5. First Runtime (implB) expands and opens the candidate; second Runtime (implA, same key `audit3.impl@1.0.0`, different setup body): `ENTRY_ACTIVATION_FAILED … has conflicting structural manifests.` cause `DUPLICATE_DEFINITION` (expected/actual differ only in `setup=` digest); third Runtime (metadata-only copy) expands but `inspect().definitions.warnings` = `["Service Revision audit3.impl@1.0.0 was loaded with different non-semantic metadata."]`; control with a fresh Contract object: fine. | Scope the cache per Runtime (own it in the planner/host, or key the WeakMap by the host) or key it by the physical `revision.source` object (`WeakMap<ServiceRevision, EntryDescriptor>`), so a synthetic Entry never references a descriptor another Runtime canonicalized. Regression: two Runtimes, two physical copies, one shared Contract. | Semantic model: Runtime isolation (K01; a Runtime is a closed definition set, `SEMANTIC_MODEL.md:63` "not Runtime-global or process-global"). On the deprecated `C.selector` path, but `C.selector` is still shipped and tested. |
| F-CL3-02 | major | The D40 drift check (`compiledExact` → `DUPLICATE_DEFINITION` when a physical copy has a different setup body) runs only inside `GraphBuilder`, i.e. on a **cold** plan. The template key identifies an Entry by `entryDefinitionSignature` (keys of the referenced revisions only), so an Entry copy that references a **drifted** revision hits the template solved for the canonical copy, `assignSlots` runs and the **canonical setup executes silently**. `check()`/`explain()` warm the cache and hide the drift for a later `enter()`. After eviction the same call is `DUPLICATE_DEFINITION` again: the diagnosis depends on cache state. Same bypass for a range origin whose family drifts in `uniqueWithin` (M3). | `packages/core/src/internal/entry-planner.ts:248-256` (hit → `assignSlots` only), `:68-87` (`entryDefinitionSignature`: revision keys), `:435-472` (`planTemplateKey`), `:479-496` (cold path builds the graph); `packages/core/src/internal/graph-builder.ts:104-115` (`host.compiledExact(dependency)` only here), `:117-135` (range: `registerFamily` only here); `definition-compiler.ts:121-132`. | `07-cache-hit-skips-drift-check.probe.mjs` → 5/7: cold `DUPLICATE_DEFINITION`; warm (canonical copy entered first) → `fulfilled`, `cacheHits: 1`, instance `{flavour:'canonical'}`; after `check(EntryCanonical)` → `enter(EntryDrifted)` `fulfilled`; with `planCache:{maxEntries:1}` + eviction → `DUPLICATE_DEFINITION`. `09-misc.probe.mjs` M3 → cold `DUPLICATE_DEFINITION`, warm `fulfilled` for a range origin whose family drifts in `uniqueWithin`. | On a template hit, still validate the descriptors the Entry references before `assignSlots`: for each root site call `compiledExact` (exact ref) / `registerFamily` + family drift check (range origin) — cheap and idempotent; or fold `revisionStructuralSignature` of every referenced descriptor into `entryDefinitionSignature` so a drifted copy cannot hit. Regression: warm cache + drifted copy (enter and check) → `DUPLICATE_DEFINITION`. | Semantic model: R17 (cache on/off/evicting must give the same result), R20/D40 (drifted copies are diagnosed), `SEMANTIC_MODEL.md:20` (planning "registers every descriptor it meets"). |
| F-CL3-03 | major | "If that Promise is garbage-collected first … the attempt is closed as unreachable (its cleanups run, `attempt-unreachable` is reported)" is **not guaranteed**. The ledger holds the attempt only through a `WeakRef`, and the `FinalizationRegistry` holds only the attempt id. When the caller no longer holds the Env (the normal case after a bounded close), Env → slot → attempt and the raw Promise die in the **same** GC, the `WeakRef` is cleared before the callback runs, `deref()` is `undefined` and the callback returns: **no cleanups, no event, the ledger record is deleted** — a silent leak of everything `onDispose` registered, invisible to `inspect()` and `runtime.dispose()`. It works only when something else pins the attempt during that GC (the caller still holds the Env, or `gc()` runs in the same job as `new WeakRef(env)`). The R-3 regression test takes the "kept" Env's event and asserts only `>= 1`, so it cannot see the dropped Env's missing cleanup. | `packages/core/src/internal/materializer.ts:562-578` (`registerUnsettled`: `attempt: new WeakRef(attempt)` `:570`, `this.unreachable.register(rawPromise, attempt.id, attempt)` `:577`), `:580-587` (`attemptUnreachable`: `this.unsettled.delete(id)` `:583` **before** `record.attempt.deref()` `:584`, `if (!attempt \|\| attempt.rawSettled) return` `:585`), `:604-650` (`closeUnsettled`, the only place cleanups of an unsettled attempt run). Test: `packages/core/tests/v05-review-lifecycle.test.mjs:406` (`cleanups >= 1`), `:408` (`unreachableEvents >= 1`) with one dropped and one kept Env. | `01b-unreachable-repeat.probe.mjs` (6 fresh `--expose-gc --unhandled-rejections=strict` processes per variant) → `single` (gc in the same job as the WeakRef of the Env): cleanup + event 6/6; **`single-yield` (one `setTimeout(0)` between the drop and the first GC): dropped Env collected 6/6, cleanup `false`, event `false`, ledger `0` in 6/6**; **`pair` (R-3 shape): dropped Env collected 6/6, cleanup/event `false` 6/6, kept Env's cleanup `true`** (that is the event the test counts). Mechanism isolated in pure V8 by `01c-v8-weak-order.mjs`: a token reachable only through the registry target and a ledger `WeakRef` is `deref() === undefined` inside the cleanup callback whenever a job boundary precedes the GC (`yield-then-gc: tokenAlive:false` 5/5) and alive only when the GC runs in the WeakRef's own job (`immediate-gc`/`churn-then-gc: tokenAlive:true` 5/5). `01-unreachable-dropped-handle.probe.mjs` (9/9) shows the kept-handle path working. | Keep the attempt strongly reachable from the registry cell: `this.unreachable.register(rawPromise, { id, attempt }, attempt)` (the attempt does not reference the raw Promise, so this cannot prevent the Promise's collection; retention stays "bounded by the reachability of the user's own setup Promise" exactly as documented); the ledger record can then hold the attempt strongly too, and `attemptUnreachable` should delete the record only after `closeUnsettled` has started. Tighten R-3: assert `cleanups === 2`, `unreachableEvents === 2`, and an `attempt-unreachable` event carrying the dropped Env's id. | Semantic model violation (`SEMANTIC_MODEL.md:101`, `:115`; `API_REFERENCE.md:139`, `:191`; `SEMANTIC_CHANGES_V05.md:44`). Padded test. |
| F-CL3-04 | minor | Plans depend on the **insertion order of `requires` keys**. Choice sites are resolved in `Object.entries` order with DFS backtracking, so two Entries (or Services) that differ only in key order plan different topologies; the structural signature sorts keys, so such copies are not `DUPLICATE_DEFINITION` but share a template key: the second copy silently gets the first copy's plan (cached ≠ its own cold plan, R17). For Services the first admitted copy canonicalizes, so **two Runtimes built from the same set of definitions in a different `services` order plan differently** (M2). | `packages/core/src/internal/graph-builder.ts:368-371` (`for (const [key, dependency] of Object.entries(revision.requires))`; root sites likewise `:79-85`), `packages/core/src/internal/identity.ts:114-130` (sorted signature), `packages/core/src/internal/entry-planner.ts:68-87` (sorted `entryDefinitionSignature`), `:248-256` (hit path). | `06-requires-order-determinism.probe.mjs` → 2/4: cold `{p,q}` → `{"p":"p@2.0.0","q":"q@1.0.0"}`, cold `{q,p}` → `{"q":"q@2.0.0","p":"p@1.0.0"}`; same Runtime, cache on: second copy `hits:1` and gets the first copy's plan (≠ its cold plan); no `DUPLICATE_DEFINITION`. `09-misc.probe.mjs` M2 → the `services:[…]` order of two otherwise identical Runtimes decides the plan (`p@2/q@1` vs `q@2/p@1`). | Resolve choice sites in a canonical order (sorted site names) in `GraphBuilder`, or make key order part of the structural signature so differing copies are diagnosed. Preconditions are contrived (physical copies differing only in key order, lineage-unique family forcing a choice), hence minor. | Semantic model (determinism / order independence of a closed definition set, `SEMANTIC_MODEL.md:10`, `:55`; R17, R20). |
| F-CL3-05 | minor | Ledger/state inconsistencies in the bounded close. (a) A setup that already **failed** and whose rollback (`onDispose` cleanup) is still running when the grace ends is reported as `UNSETTLED_ATTEMPT` "… setup attempt(s) were **still running**", is **never** in `inspect().unsettledAttempts` (registration happens only when the raw Promise timed out / was abandoned), and its slot stays `abandoned` forever although the Env becomes `disposed`. (b) `handleLateSettlement` deletes the ledger record and unregisters **before** the late cleanup runs, so while the Env is still `disposing` for that cleanup the ledger is empty and `runtime.dispose()` fulfils silently. | `packages/core/src/internal/materializer.ts:204-233` (`settleSlot`: first branch marks the slot `abandoned` and reports whenever the *sequence* does not settle, `:207-220`), `:488-491` (`registerUnsettled` only for `timeout`/`abandoned` races), `:589-597` (`handleLateSettlement`: `unsettled.delete` `:594`, `unregister` `:595`, then `closeUnsettled` `:596`), `:617` (slot → `disposed` only through `closeUnsettled`); `packages/core/src/runtime.ts:342-367` (`dispose()` reports `unsettledAttempts()` only, `:353`), `:660-720` (`disposeEnv`, message `:692`). | `05-slow-rollback-in-grace.probe.mjs` → 6/10 (the four FAILs are the observations): (a) report `["UNSETTLED_ATTEMPT"]` "still running", events `["rollback-start","attempt-abandoned"]`, ledger `[]`, env `disposing`/slot `abandoned`; after the rollback env `disposed`, slot still `abandoned`; the waiter got `Error("setup failed")`. (b) after the bounded close ledger `1`/`disposing`; during the late cleanup `{state:'disposing', ledger:0, slot:'abandoned'}` and `runtime.dispose()` → "fulfilled silently"; afterwards `disposed`, `late-setup-result`. | Distinguish "rollback outstanding" from "setup running" in the report (or register such attempts in the ledger with a `rolling-back` state); set the slot `disposed` when a slow rollback completes; delete the ledger record after `closeUnsettled` (or mark it `settling`) so `runtime.dispose()` reports/awaits it. | Diagnostics contradict the documented ledger contract (`SEMANTIC_MODEL.md:115`, `API_REFERENCE.md:137`, `:191`): minor, no resource is leaked. |
| F-CL3-06 | docs | "A close is bounded by one grace period regardless of `setupDeadlineMs`" is only true per Env. A parent awaits its descendants first and only then gives its own attempts the grace, so a chain of *n* Envs each owning a stuck slot closes in ≈ *n* × grace. | `packages/core/src/runtime.ts:660-720` (`disposeEnv`: children awaited before the own `settleSlots` `:671`); `docs/API_REFERENCE.md:137`, `:171` ("bounded by one grace period"); `docs/SEMANTIC_MODEL.md:113` describes the sequential order, so the model itself implies depth × grace. | `04-tree-close-bound.probe.mjs` → 2/3: 3-level chain, `graceMs:150`, `root.dispose()` elapsed `454 ms` (bound for one grace: 300), nested `AggregateError`s with one `UNSETTLED_ATTEMPT` per level. | Docs: "bounded by one grace period per tree level"; or (model change) start the parent's grace concurrently with the descendants' close. | Documentation issue. |
| F-CL3-07 | docs | "It resolves among the revisions … the Runtime knows at the site (the admitted ones, the consumer's private closure, and the origin itself)" — in the public realm the origin is **not** a candidate when it is internal (known but not admitted): a public root site gets `MISSING_SERVICE`. The code follows D35 (public = admitted only); the sentence in §6 / API_REFERENCE promises the origin everywhere. | `packages/core/src/internal/graph-builder.ts:117-125` (`realmAllows` filter before the version filter); `docs/SEMANTIC_MODEL.md:57`; `docs/API_REFERENCE.md:105`. | `03-public-range-origin.probe.mjs` → 4/4 (all as coded, contradicting the sentence): origin is internal; public root `Private.range('*')` → `MISSING_SERVICE` (`enter` and `explain` agree); the Service-owned Entry resolves to the origin `{v:'1.0.0'}`. | Docs: "… and, in a private realm, the origin itself; a public root site sees admitted revisions only". | Documentation issue. |
| F-CL3-08 | docs | `run()`: when the callback **succeeds** but the Env close reports (`UNSETTLED_ATTEMPT` or a cleanup error), the close's `AggregateError` replaces the business result; the result is not recoverable from the error. API_REFERENCE only describes the both-fail case ("Business and cleanup errors are both kept … `error.suppressed` for `run()`"). | `packages/core/src/runtime.ts:387-402` (`executeStructured`: success path `await env.dispose(); return result` `:400-401`), `:74-89` (`addSuppressed` only on the failure path); `docs/API_REFERENCE.md:171`. | `09-misc.probe.mjs` M1 → `run()` rejected with `AggregateError("Env env-1 failed to dispose cleanly.", [UNSETTLED_ATTEMPT …])`, no `result` property. | Document it (a successful result is discarded when the close fails; use `enter()` + manual `dispose()` if the result must survive), or attach the result to the thrown error. | Documentation issue. |
| F-CL3-09 | docs | `check()`/`explain()` are documented as consuming no Env id (true) but they do consume **slot ids**: after five `check()` calls the first real Env's slots are `slot-16…slot-18`. Planning therefore leaves a visible trace in `inspect()`/diagnostics ids. | `packages/core/src/internal/entry-planner.ts:541` ff. (`assignSlots` allocates slot ids on every plan, hit or miss); `docs/SEMANTIC_MODEL.md:20`, `docs/API_REFERENCE.md:175`. | `08-controls.probe.mjs` O1 → `{"envId":"env-1","slotIds":["slot-16","slot-18","slot-17"]}`. | Allocate slot ids when a plan is committed (or document that planning consumes slot ids). | Documentation issue (cosmetic). |

### Notes on the major findings

**F-CL3-01.** The contamination needs two Runtimes in one process that share a Contract object and hold
different physical copies of one revision key — exactly the situation of a test runner or a long-lived
host that reloads a package (the hardening tests document the "physical copy" cases for one Runtime).
The failure mode is confusing: the second Runtime never admitted the first copy, yet its
`DUPLICATE_DEFINITION` names it. The metadata variant also pollutes `inspect().definitions.warnings`
of a Runtime none of whose descriptors drift.

**F-CL3-02.** The consequence is not a diagnostic but a wrong execution: the Entry copy that carries a
different `setup` runs the canonical body. The same class covers `check()` (which the docs allow to
"fill the plan cache") — a plan-only call with the canonical copy makes a later `enter()` with the
drifted copy succeed. `planCache: { maxEntries: 1 }` restores the diagnosis, which is the R17 test
shape (cache on/off must agree) that the existing tests do not exercise for drifted references.

**F-CL3-03.** The semantics the documents promise are the right ones (retention bounded by the setup
Promise; cleanups run when the Promise can no longer settle). The implementation only reaches them
when the attempt happens to be strongly reachable through something else during the GC that clears
the Promise. The `single` variant passes purely because `globalThis.gc()` runs in the same job as
`new WeakRef(env)` (spec KeepDuringJob), which is also what the R-3 test does for the kept Env; with a
single macrotask in between, nothing runs. In production nobody holds a closed Env, so the documented
`attempt-unreachable` path effectively never runs for the common case and the resources registered
via `onDispose` (sockets, timers, temp files) are leaked without any signal — the ledger is emptied
in the same callback that decides not to clean up.

## Hypotheses that held

| hypothesis | probe | result |
|---|---|---|
| D38: a deadline that fires inside the disposal grace and a late result inside the remaining grace → clean close, `late-setup-result`, cleanup ran, nothing abandoned, ledger empty, slot `disposed`. | `08-controls.probe.mjs` C1 | PASS |
| Cancellation paths (`load({signal})` while running, during recovery cooldown, pre-aborted on a failed slot) reject `LOAD_CANCELLED`, a later load recovers, and `--unhandled-rejections=strict` exits 0. | `08-controls.probe.mjs` C2 | PASS |
| Owner disposal cancels a recovery cooldown promptly (`INVALID_ENV_STATE`, ≈1 ms) and no dormant materialization runs after the owner closed. | `08-controls.probe.mjs` C3 | PASS |
| BoundEntry: `check()`/`explain()` allowed while the anchor activates, `enter()` → `OWNER_NOT_READY`, no Env id consumed; after Ready the child is anchored at the owner; after the anchor left → `INVALID_ENV_STATE`. | `08-controls.probe.mjs` C4 | PASS |
| D37: lineage anchors are part of the template key — anchored/unanchored parents in both orders agree with cold plans for `explain()` and `enter()`; `check()` publishes no anchor. | `08-controls.probe.mjs` C5 | PASS |
| D35/D36 Contract view: an admitted covering revision beats the private origin; a non-covering revision is not a candidate (`INCOMPATIBLE_IMPLEMENTATION`, backtrackable, `details.candidates`); fallback to the origin when only a non-covering revision is admitted. | `08-controls.probe.mjs` C6, `03-public-range-origin.probe.mjs` | PASS |
| Range origin visibility follows D35 (public: admitted only; private: origin included) consistently for `enter()` and `explain()`. | `03-public-range-origin.probe.mjs` | PASS (docs wording is F-CL3-07) |
| The unreachable path works when the caller still holds the Env (kept handle): cleanups run, `attempt-unreachable` fires, ledger empties, Env `disposed`. | `01-unreachable-dropped-handle.probe.mjs` | PASS (9/9) |
| Copies differing only in `requires` key order are not `DUPLICATE_DEFINITION` (signature sorts keys). | `06-requires-order-determinism.probe.mjs` check 2 | PASS (part of F-CL3-04) |
| Drifted setup body is `DUPLICATE_DEFINITION` on a cold plan and again after template eviction. | `07-cache-hit-skips-drift-check.probe.mjs`, `09-misc.probe.mjs` M3 | PASS (part of F-CL3-02) |
| Bounded close reports each level's abandoned attempt in a nested `AggregateError`. | `04-tree-close-bound.probe.mjs` | PASS |
| A failed setup's waiter receives the setup failure even when the close abandons the slow rollback. | `05-slow-rollback-in-grace.probe.mjs` (a) | PASS |

Other observation (not assessed against a document claim): `load({ signal: <already aborted> })` on
synthetic refs (`C.all`, an Entry-bound ref) fulfils, on a Service ref it rejects `LOAD_CANCELLED`
(`08-controls.probe.mjs` O1).

## Limits

- GC-dependent behaviour (F-CL3-03) was measured on Node v26.0.0 / V8 with `--expose-gc`; the
  mechanism (`WeakRef` cleared in the same cycle that collects the registry target, KeepDuringJob pin
  within one job) is specified behaviour, but counts per run are empirical (6 processes per variant).
- F-CL3-01 is on the deprecated `C.selector` path; `auto`/`C.all` do not use `candidateEntryCache`.
- F-CL3-04 needs physical copies that differ only in key order plus a lineage-unique family that forces
  backtracking; the ordinary single-copy case is deterministic per Runtime.
- Timing probes (04, 05) use small grace values (40–150 ms); elapsed numbers vary by a few ms.
- Only `packages/core/dist` as built at HEAD was exercised; line numbers refer to `packages/core/src`
  at `32d212a`. No Hyla tests, no database, no rebuild.
- Depth over breadth: realm/closure key handling, semver edge cases and the SCC disposal order were
  read but not probed beyond the C-series controls.

## Probe index

| file | purpose | final exit |
|---|---|---|
| `_harness.mjs` | PASS/FAIL harness (`check`, `note`, `settle`, `makeDefine`, `main`) | – |
| `01-unreachable-dropped-handle.probe.mjs` | unreachable path with kept/dropped handles (child process, `--expose-gc`) | 0 |
| `01b-unreachable-repeat.probe.mjs` | 6 runs × `single` / `single-yield` / `pair` | 1 (F-CL3-03) |
| `01c-v8-weak-order.mjs` | pure-V8 mechanism check for F-CL3-03 | 0 (informational) |
| `02-selector-cross-runtime-cache.probe.mjs` | module-global candidate cache across Runtimes | 1 (F-CL3-01) |
| `03-public-range-origin.probe.mjs` | range origin visibility by realm | 0 (F-CL3-07 is wording) |
| `04-tree-close-bound.probe.mjs` | depth × grace | 1 (F-CL3-06) |
| `05-slow-rollback-in-grace.probe.mjs` | ledger/state around slow rollback and late cleanup | 1 (F-CL3-05) |
| `06-requires-order-determinism.probe.mjs` | key-order dependence, cached ≠ cold | 1 (F-CL3-04) |
| `07-cache-hit-skips-drift-check.probe.mjs` | template hit bypasses D40 | 1 (F-CL3-02) |
| `08-controls.probe.mjs` | C1–C6 controls, O1 observations | 0 |
| `09-misc.probe.mjs` | M1 run() result loss, M2 admission order, M3 family drift on hit | 1 (F-CL3-02/04/08) |
| `run-all.sh`, `RUN-LOG.txt` | runner and the raw output of the final run | – |

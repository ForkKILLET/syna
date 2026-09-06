# Syna Core Semantic Model v0 (v0.5 wording)

## 1. Static Runtime

A Runtime is finite, closed, and immutable. It contains:

- a public admission set of exact Service revisions;
- the exact transitive private definition closure;
- nominal Contract, Input, Binding, and Entry descriptors;
- deterministic version and implementation policies.

Runtime construction creates no Env, logical slot, or Service instance.

## 2. Entry and Env

Every Env is created by exactly one Entry invocation. A parentless invocation creates a root; an invocation anchored at an existing Env creates a child. Envs form a single-parent forest and cannot merge.

Entry planning is atomic. Failure before commit creates no Env. A committed Env has immutable topology.

`check()` and `explain()` plan without committing: no setup runs, no Env or anchor is published, no Env id and no slot id is consumed (planning ids are numbered apart). Planning is not side-effect free in the strict sense: it registers every descriptor it meets — and diagnoses a drifted copy of a definition exactly as `enter()` would, whether the plan is solved or taken from the cache — and may fill the plan cache. Both are bounded by the static definition set of §1 (`inspect().definitions` exposes the counts), so repeated planning cannot grow the Runtime beyond that set.

## 3. Nodes and slots

The resolved graph contains:

- Service nodes;
- Input nodes;
- Binding projection nodes;
- Contract selector nodes;
- strong all-implementations nodes;
- owner-anchored Entry nodes.

Only Service nodes materialize user instances. Other nodes use immediately-ready synthetic or value slots.

For each Env and each canonical resolved node, there is at most one visible canonical slot. A slot has exactly one owner Env. A descendant may reuse an ancestor-owned slot.

## 4. Parent-only canonical reuse

A child reuses the greatest valid subset of its **parent's currently visible** slots (a parent slot may be owned by an earlier ancestor). A parent slot is reusable only when the child has the same nominal node and every bound dependency slot remains identical. A changed dependency slot removes the dependant from the reuse set; this propagates to a fixed point over the reverse dependency graph. Historical slots that the parent no longer exposes are never searched. Payload equality and whether setup already ran are never reuse criteria.

`fresh` is a hard non-reuse constraint. `share` is a hard reuse constraint. Failure to satisfy a hard constraint aborts the Entry.

Node correspondence in the current model is nominal-ID-preserving. General bisimulation partition refinement is not part of the runtime hot path.

## 5. Inputs

An Input is a typed external contextual fact with no Syna-owned lifecycle. Explicit local provision creates a new Input slot even when its payload is reference-equal to an ancestor payload. Inheritance is decided by the Entry's declaration, not by the call: an Entry that does not declare an Input among its `parameters` resolves it to the nearest ancestor slot (`MISSING_INPUT` when no ancestor provides it); an Entry that declares it must be given it on every enter, and omitting the key is `MISSING_INPUT`, never inheritance.

Changing an Input slot forks exactly the reverse dependency closure that observes it.

## 6. Service versions

Service Family and exact Service Revision are distinct identities. Multiple revisions of one Family may coexist. The same revision may own different slots in different Env worlds.

A normal static dependency choice site has one deterministic result in a lineage. A new Entry root site may select another compatible revision without rewriting an existing Service dependency edge.

A range reference is taken from one revision, its origin. It resolves among the revisions of that Family the Runtime knows at the site — the admitted ones and, in a private realm, the consumer's private closure and the origin itself; in the public realm an origin that was never admitted is not a candidate — that satisfy the range and provide every Contract the origin provides. A range therefore loads the origin's Contract view, never a revision-private shape.

## 7. Lineage uniqueness

A Family with `uniqueWithin: 'lineage'` anchors when it first appears in an Env lineage. Descendants may not select a different revision, resolved structure, or slot for that Family. Siblings whose common ancestor never anchored the Family may anchor independently.

This is not Runtime-global or process-global uniqueness. The anchor persists through descendants that do not use the Family; when the Family reappears it re-attaches to the anchored slot only if every dependency slot matches, otherwise the Entry fails with the full conflict chain.

## 8. Contracts

A Contract has nominal runtime identity and compile-time API shape, but no instance lifecycle.

- A naked Contract requires an unambiguous implementation family.
- `auto(C)` creates an independent implementation choice site governed by explicit Runtime policy.
- `C.all` requires all admitted implementation revisions to coexist in the current Env (recommended collection form).
- `C.selector` is a deprecated compatibility form: candidates are pre-flighted as independent child plans; opening one needs a Ready anchor.

Private transitive Service definitions are not discoverable Contract candidates unless explicitly admitted.

## 9. Bindings

A Binding is a named inherited implementation choice. An Entry assignment resolves a durable family/range intent to an exact admitted Service revision. Reassigning the same exact choice is a no-op; choosing a different revision creates a new Binding choice/projection slot and forks its dependants.

Selection identity and Service instance identity remain distinct: descendants can retain one Binding choice while provider dependencies cause request-local provider slots.

## 10. Owner-anchored Entries

An Entry may be a Service dependency. The injected Anchored Entry is anchored at the unique owner Env of the consuming Service slot, not at an ambient caller Env. This permits a Service to construct typed child worlds without making “current Env” dynamic or ambiguous. Its roots resolve in the owner's private realm: the admitted revisions plus the owner's transitive closure over exact references and range origins; Contract discovery stays public.

A Service-owned Anchored Entry can only be entered from a Ready owner. Invoking it while the owner is still activating rejects with `OWNER_NOT_READY` (an ordinary rejected Promise); invoking it after the owner begins disposal rejects with `INVALID_ENV_STATE`. There is no activation transaction and no provisional Ready.

## 11. Materialization

Topology precedes materialization. A Service slot moves through:

```text
Dormant → Starting → Ready → Disposing → Disposed
              └────→ Failed ──(recovery)──→ Starting
                       │  (final once a rollback failed)
                       └→ Abandoned ──(late settlement / unreachable)──→ Disposed
```

`ServiceRef.load()` materializes an already-planned slot and returns a plain Promise. Whether the caller awaits it is ordinary JavaScript; the Runtime adds no barrier and no obligation. One actual `setup()` execution is an attempt; each caller is a waiter; concurrent waiters join one attempt; a waiter may end its own wait with an AbortSignal without affecting the attempt.

Failure is sticky by default. A failure policy may retry within one sequence and may allow one shared recovery sequence on a later `load()` after cooldown. A failed rollback ends both: a slot whose cleanup threw (inside a sequence, or while a late result was being cleaned up) is final and refuses recovery with `ROLLBACK_FAILED`, because the resources that attempt acquired are no longer under Syna control and a new attempt would stack on top of them. A per-attempt initialization deadline turns a never-settling setup into `INITIALIZATION_TIMEOUT`; the attempt is then blocked from overlapping with a new one until its raw Promise settles, and late results are discarded, cleaned up and reported. An abandoned attempt (§13) ends the same way when its raw Promise settles late; if that Promise is garbage-collected first, nothing can settle it any more and the attempt is closed as unreachable (its cleanups run, `attempt-unreachable` is reported). Retention of an attempt is therefore bounded by the reachability of the user's own setup Promise, never by the Runtime.

An eager Service slot must be Ready before its Env becomes Ready. Unrelated eager slots have no startup order guarantee.

## 12. Cycles

Structural dependency cycles are legal. Their strongly connected components fork as indivisible reuse units.

A cycle of setup waits cannot be proven from Promises. The Runtime records which `load()` calls each attempt issued and, when the deadline expires, reports the observed load-call cycle as diagnostic information — an observation, not a deadlock proof. Legal pre-fetching and racing patterns are never misreported.

## 13. Disposal

A parent cannot dispose before its descendants. Closing first refuses new work and aborts the owner signal of the whole subtree, then waits for descendants, then gives each owned in-flight attempt the disposal grace, then disposes owned slots. Each Env disposes only Service slots it owns; attempts that did not settle within the grace — a setup still pending, or one that settled but whose rollback is still running — are abandoned and reported (`UNSETTLED_ATTEMPT`, naming the dependency slots the attempt may still use and the phase it is in) rather than claimed closed. The bound is per Env: descendants close first, so a tree closes in at most one grace per level.

The close is bounded. When it ends, the Env leaves the tree and the Runtime's registries whether or not attempts are outstanding: its parent no longer waits for it and nothing in the Runtime retains its graph. Its state stays `disposing` while an attempt abandoned by that close (its own, or one of a descendant closed by the same call) is outstanding, and becomes `disposed` when the last of them settles late or is closed as unreachable (§11). The Runtime keeps a ledger of outstanding attempts (`inspect().unsettledAttempts`: timed out, abandoned, rolling back, settling) that holds each attempt until it settles; retention is bounded by the user's own setup Promise, whose collection closes the attempt as unreachable (§11). `runtime.dispose()` waits up to the grace for attempts that are settling and reports the rest.

Dependencies of an abandoned attempt are disposed in the normal order after the grace. The model has no revocation and no forced termination (§14), so a setup that keeps running past the grace may observe closed dependencies; this is the acknowledged consequence of a bounded close, reported with the attempt, not a state the model can prevent.

For materialized owned slots, the structural graph is condensed to an SCC DAG. SCCs are disposed dependant-first. Within an SCC, cleanup uses reverse materialization-completion order and offers no stronger business ordering guarantee.

No new dormant Service may be materialized once its owner Env begins disposal.

## 14. Explicit limitations

Core v0 deliberately does not define:

- Runtime hot installation/uninstallation;
- Env merge or multiple parents;
- ambient dynamic caller Env;
- reactive Input mutation tracking;
- process/distributed singleton guarantees;
- automatic cross-Contract runtime adapters;
- forced revocation of escaped plain JavaScript Service instances;
- forced termination of a `setup()` that ignores its stop signal: such an attempt is abandoned and reported, never killed, and the slots it depends on are closed in the normal order regardless.

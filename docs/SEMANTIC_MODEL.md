# Syna Core Semantic Model v0

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

## 3. Nodes and slots

The resolved graph contains:

- Service nodes;
- Input nodes;
- Binding projection nodes;
- Contract selector nodes;
- strong all-implementations nodes;
- owner-bound Entry nodes.

Only Service nodes materialize user instances. Other nodes use immediately-ready synthetic or value slots.

For each Env and each canonical resolved node, there is at most one visible canonical slot. A slot has exactly one owner Env. A descendant may reuse an ancestor-owned slot.

## 4. Maximal ancestral reuse

A child reuses the maximum valid subset of its parent’s visible slots. A parent slot is reusable only when the child has the same nominal node and every bound dependency slot remains identical. A changed dependency slot removes the dependent from the reuse set; this propagates to a fixed point over the reverse dependency graph.

`fresh` is a hard non-reuse constraint. `share` is a hard reuse constraint. Failure to satisfy a hard constraint aborts the Entry.

Node correspondence in the current model is nominal-ID-preserving. General bisimulation partition refinement is not part of the runtime hot path.

## 5. Inputs

An Input is a typed external contextual fact with no Syna-owned lifecycle. Explicit local provision creates a new Input slot even when its payload is reference-equal to an ancestor payload. Omission inherits the nearest ancestor slot.

Changing an Input slot forks exactly the reverse dependency closure that observes it.

## 6. Service versions

Service Family and exact Service Revision are distinct identities. Multiple revisions of one Family may coexist. The same revision may own different slots in different Env worlds.

A normal static dependency choice site has one deterministic result in a lineage. A new Entry root site may select another compatible revision without rewriting an existing Service dependency edge.

## 7. Lineage uniqueness

A Family with `uniqueWithin: 'lineage'` anchors when it first appears in an Env lineage. Descendants may not select a different revision, resolved structure, or slot for that Family. Siblings whose common ancestor never anchored the Family may anchor independently.

This is not Runtime-global or process-global uniqueness.

## 8. Contracts

A Contract has nominal runtime identity and compile-time API shape, but no instance lifecycle.

- A naked Contract requires an unambiguous implementation family.
- `auto(C)` creates an independent implementation choice site governed by explicit Runtime policy.
- `C.selector` freezes admitted candidates and preflights each in an independent child world. Candidates need not coexist.
- `C.all` requires all admitted implementation revisions to coexist in the current Env.

Private transitive Service definitions are not discoverable Contract candidates unless explicitly admitted.

## 9. Bindings

A Binding is a named inherited implementation choice. An Entry assignment resolves a durable family/range intent to an exact admitted Service revision. Reassigning the same exact choice is a no-op; choosing a different revision creates a new Binding choice/projection slot and forks its dependants.

Selection identity and Service instance identity remain distinct: descendants can retain one Binding choice while provider dependencies cause request-local provider slots.

## 10. Owner-bound Entries

An Entry may be a Service dependency. The injected Bound Entry is anchored at the unique owner Env of the consuming Service slot, not at an ambient caller Env. This permits a Service to construct typed child worlds without making “current Env” dynamic or ambiguous.

A Service-owned Bound Entry may be invoked while its owner Env is activating. The child becomes part of the same activation transaction: failure rolls back the child, and parent/child setup waits participate in the same materialization-cycle rules. Invocation after the owner begins disposal is forbidden.

## 11. Materialization

Topology precedes materialization. A Service slot moves through:

```text
Dormant → Starting → Ready → Disposing → Disposed
              └────→ Failed
```

`DependencyRef.load()` materializes an already-planned slot and, when called during setup, establishes a strong dependency in that setup's completion barrier. This remains true even if user code discards the returned Promise. `DependencyRef.preload()` is the explicit non-blocking alternative and does not make the caller setup wait.

Concurrent callers share one setup sequence. Failure is sticky by default. A failure policy may retry within one sequence and may optionally permit one atomically shared recovery sequence on a later `load()` after cooldown.

An eager Service slot must be Ready before its Env becomes Ready. Unrelated eager slots have no startup order guarantee and may run concurrently.

## 12. Cycles

Structural dependency cycles are legal. Their strongly connected components fork as indivisible reuse units.

During setup, each strong `load()` adds an edge to the dynamic materialization graph and joins the caller's completion barrier. Adding an edge that closes a cycle fails immediately with `CIRCULAR_MATERIALIZATION`. Because strong-vs-background intent is explicit (`load()` versus `preload()`), the Runtime does not guess whether JavaScript happened to await a Promise.

## 13. Disposal

A parent cannot dispose before its descendants. Each Env disposes only Service slots it owns.

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
- forced revocation of escaped plain JavaScript Service instances.

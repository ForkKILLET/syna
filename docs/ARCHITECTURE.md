# Architecture

## Source layout

```text
packages/core/src/
├── definition.ts                 package-scoped descriptor constructors
├── descriptors.ts                public TypeScript contracts
├── loading.ts                    typed `loadAll()` helper
├── runtime.ts                    public Runtime/Env orchestration
├── semver.ts                     bounded semantic-version parser and matcher
├── graph.ts                      SCC discovery and dependant-first order
├── errors.ts                     structured errors and diagnostics
└── internal/
    ├── definition-registry.ts    admission, private definitions, overrides, warnings
    ├── resolution-realm.ts       public and Service-owned Entry authority
    ├── graph-builder.ts          dependency lowering and exact graph construction
    ├── entry-planner.ts          immutable planning and canonical-slot reuse
    ├── plan-cache.ts             bounded deterministic LRU
    ├── materializer.ts           setup barriers, wait graph, retry, cancellation
    ├── implementation-directory.ts Contract candidates, refs, selector/set views
    ├── runtime-model.ts          internal nodes, slots, plans, and states
    ├── runtime-utils.ts          nominal identity and ordering helpers
    ├── abort.ts                  abort-aware delay utilities
    └── solve-errors.ts           explicit backtrackable unsatisfiability
```

## Definition registry

`createRuntime()` compiles a finite immutable public admission set and exact private dependency closure. Definition overrides are applied at this layer: the source keeps its public nominal identity while its executable manifest comes from the replacement. Contract enumeration therefore sees one coherent source candidate rather than source/target phantom duplicates.

A Service-owned Entry receives a restricted resolution realm. Its declared exact private roots and their transitive exact dependencies are available; unrelated private definitions and private Contract implementations remain undiscoverable.

## Entry planning

An Entry plan combines inherited roots, local requirements, Input provisions, Binding assignments, deterministic choices, Contract lowering, scope constraints, and lineage-uniqueness anchors.

The planner uses stable nominal node IDs and computes the greatest valid parent-slot reuse fixed point. General bisimulation is not in the hot path. A changed dependency slot removes its dependant from the reuse set until convergence, including SCC-wide propagation.

Compiled graph templates are cached by semantic shape only: parent plan signature, Entry definition, effective Binding choices, scope directives, resolution realm, and policy-sensitive choices. Env ids, slot ids, Input payloads, and CandidateRef identities never enter the key. The cache is bounded LRU storage with visible hit/miss/eviction counters.

## Contract lowering

- exact Service and Service range → one Service node;
- naked Contract / `auto(C)` → one selected implementation node;
- `C.selector` → a synthetic selector node with frozen candidate descriptors and stable candidate Entry templates;
- `C.all` → a synthetic same-Env set with an edge to every candidate node;
- Binding → a synthetic projection to the selected provider;
- Entry dependency → a synthetic BoundEntry carrying owner anchor and resolution realm.

## Materialization

Topology and slots exist before setup. A dependency ref has two deliberately different operations:

```text
load()    strong setup dependency; joins the caller's completion barrier
preload() background warm-up; does not make the caller setup wait
```

The materializer therefore never tries to infer JavaScript `await` behavior. Strong edges form an exact dynamic wait graph; a cycle fails immediately. Concurrent callers of one slot join one setup sequence.

Retry/backoff is abort-aware. After exhaustion, a Service may remain sticky or allow one future `load()` to start a new shared sequence after cooldown. Disposal prevents additional attempts and cancels pending backoff.

## Activation transactions

Eager slots must become Ready before the Env is published. A Service-owned Entry may create a child during owner activation; the child is registered in the same structured activation tree. Any failure rolls back descendants and locally started resources. A child that waits back into its still-starting owner produces a normal materialization-cycle error.

## Disposal

Disposal closes descendants first, aborts the owner signal, waits for in-flight setup to settle, condenses materialized owned Service slots into an SCC DAG, and disposes dependants before dependencies. SCC-internal cleanup uses reverse materialization completion order without stronger business guarantees.

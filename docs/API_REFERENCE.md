# `@syna/core` v0.4.0 API reference

Syna exposes immutable nominal descriptors and Entry-driven Env construction. Runtime graph solving is global; TypeScript checks local shapes and descriptor compatibility.

## Package definition scope

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

`package.json#version` is the exact version of every Service revision created by this package. Contract, Input, Binding, and Entry identities use an independent `apiVersion` (default `1`).

## Contract

```ts
interface Storage {
  read(key: string): Promise<Uint8Array>
}

const Storage = define.contract<Storage>('storage', {
  apiVersion: 1,
  metadata: { displayName: 'Object Storage' },
})
```

A Contract has TypeScript API shape and runtime nominal identity, but no instance, slot lifecycle, setup, or disposal.

Dependency forms:

```ts
requires: {
  strict: Storage,          // one unambiguous implementation family
  automatic: auto(Storage),// Runtime policy selects this independent edge
  selectable: Storage.selector, // candidate-specific child worlds
  all: Storage.all,        // every candidate coexists in this Env
}
```

A naked Contract rejects ambiguity across implementation families. `auto(C)` invokes `RuntimePolicy.orderAutoCandidates`; the default policy also rejects family ambiguity, so applications that want automatic provider choice must supply a meaningful policy.

`C.selector` freezes admitted candidates and preflights each as an independent child world. Unavailable candidates remain visible with diagnostics. `C.all` is the stronger same-Env collection and fails unless all admitted revisions can coexist.

## Input

```ts
const CurrentRequest = define.input<Request>('current-request', {
  apiVersion: 1,
  metadata: { displayName: 'Current request' },
})
```

An Input is an external, lifecycle-free contextual fact. An Entry parameter creates a new Input slot. A descendant that omits the parameter inherits the nearest ancestor slot. Explicitly providing the same JavaScript payload again still creates a new slot; Syna never guesses semantic equality from payload equality.

## Binding

```ts
const SummaryLlm = define.binding('summary-llm', Llm, {
  apiVersion: 1,
})
```

A Binding is a named, inheritable business-level implementation choice. Services depend on it directly and receive the Contract API.

```ts
const ref = SummaryLlm.to(OpenAI)
const pinned = SummaryLlm.to(OpenAI, '^2.4.0')
const parsed = SummaryLlm.parse(json)
```

The default compatible range is based on the exact installed revision (`0.2.0 → ^0.2.0`, `2.4.1 → ^2.4.1`). Reassigning a Binding to the same exact effective revision is a no-op; this intentionally differs from Input reprovision.

## Service

```ts
const Repository = define.service('repository', {
  requires: {
    database: Database,
    request: CurrentRequest,
  },
  provides: [RepositoryContract],
  eager: false,
  uniqueWithin: 'lineage',
  failure: {
    attempts: 3,
    delayMs: 100,
    afterExhaustion: 'retry-on-next-load',
    cooldownMs: 500,
  },
  metadata: { displayName: 'Repository' },
  revisionMetadata: { data: { backend: 'postgres' } },
  async setup({ database, request }, { signal, onDispose }) {
    const { db, req } = await loadAll({ db: database, req: request })
    onDispose(() => db.close())
    return { /* opaque Service instance */ }
  },
})
```

Options:

- `requires`: complete static dependency map.
- `provides`: Contracts explicitly provided by the revision.
- `eager`: the slot must be Ready before its Env becomes Ready.
- `uniqueWithin: 'lineage'`: after the Family anchors, descendants cannot own or select a divergent node for it.
- `failure`: attempts within one materialization sequence plus optional future-load recovery.
- `metadata`: Family-facing metadata; `revisionMetadata`: revision-specific metadata.
- `setup`: constructs the opaque instance.

### `DependencyRef<T>`

```ts
interface DependencyRef<T> {
  load(): Promise<T>
  preload(): void
}
```

`load()` is the sole strong materialization operation. During setup it registers a strong dependency and participates in the setup completion barrier even when its Promise is not explicitly awaited. This makes wait-cycle detection deterministic.

`preload()` starts best-effort materialization without making the caller setup wait. Its failure does not fail the caller; a later `load()` observes the target slot's state.

```ts
const { database, logger } = await loadAll({ database, logger })
```

`loadAll()` loads a typed record concurrently and preserves its keys.

Dependency descriptors may be exact Service revisions, Service ranges, Contracts, `auto(C)`, `C.selector`, `C.all`, Inputs, Bindings, Entries, or `forward(() => dependency)` for JavaScript declaration cycles.

## Entry

```ts
const RequestEntry = define.entry('request', {
  requires: {
    handler: RequestHandler,
  },
  parameters: {
    request: CurrentRequest,
    provider: SummaryLlm,
  },
  scope: {
    fresh: [RequestCache.family],
    share: [Database.family],
  },
  apiVersion: 1,
  metadata: { displayName: 'Request world' },
})
```

`requires` is the typed capability surface returned to the external caller. `parameters` are Input provisions and Binding assignments supplied at invocation. The invocation object is flat because descriptor types determine each field's value type.

`scope.fresh` and `scope.share` accept exact Service revisions or Service families. The planner computes the resulting reverse dependency closure; callers do not list dependants manually.

## Runtime

```ts
const runtime = createRuntime({
  services: [Application, OpenAI, Claude],
  policy: {
    orderAutoCandidates(contract, candidates, context) { /* total ordering */ },
    orderVersionCandidates(family, candidates, context) { /* total ordering */ },
  },
  overrides: [override(Postgres, FakePostgres)],
  planCache: { maxEntries: 512 },
})
```

`services` is the immutable public admission set. Exact transitive dependencies form private definition realms, but do not become public Entry roots or Contract candidates.

`override(source, implementation)` is a construction-time definition override. The source keeps its nominal identity and public Contract/admission position while setup and dependencies come from the replacement. This keeps exact dependencies, Contract discovery, selectors, persistent refs, and `fresh/share` coherent.

The plan cache is bounded LRU storage. Cache keys describe semantic plan shape and never include Env or slot instance ids.

Runtime methods:

```ts
runtime.enter(entry, parameters?)
runtime.run(entry, parameters?, callback)
runtime.check(entry, parameters?)
runtime.inspect()
runtime.dispose()
await runtime[Symbol.asyncDispose]()
```

`check()` plans without publishing an Env or materializing eager Services.

## Env

```ts
env.enter(entry, parameters?)
env.run(entry, parameters?, callback)
env.check(entry, parameters?)
env.derive(scope?)
env.bind(entry)
env.inspect()
env.dispose()
await env[Symbol.asyncDispose]()
```

A child cannot outlive its parent. Every slot is disposed only by its owner Env. Service-owned Entry dependencies use a private resolution realm for their declared exact roots and are anchored at the owner Env of the consuming Service slot.

A Service-owned Entry may participate in the owner's activation transaction. A failure rolls back structured children; a child-eager-to-parent setup cycle is detected through the same materialization graph.

## Implementation selector

```ts
const selector = await selectorDependency.load()
for (const candidate of selector.candidates) {
  console.log(candidate.familyId, candidate.version, candidate.availability)
}

await using lease = await selector.open(candidate)
const implementation = await lease.implementation.load()
```

`selector.open()` creates a candidate-specific child Env. `selector.run()` is the structured open/use/dispose shorthand. Candidate refs are selector-slot-local; persistent refs are durable family/version intents.

## Strong implementation set

`Contract.all` returns an `ImplementationSet`. Every candidate is already part of the current Env topology and can be loaded directly:

```ts
const set = await allDependency.load()
const implementation = await set.load(set.candidates[0])
```

## Failure and cancellation

Setup attempts and delays are abort-aware. Once the owner Env starts disposing, no new attempt or recovery generation begins. With `afterExhaustion: 'retry-on-next-load'`, a future load may atomically start one new sequence after the cooldown; concurrent callers join it.

## Disposal

Runtime, Env, and implementation leases support explicit `dispose()` and `Symbol.asyncDispose`. Structured `run()` preserves a callback failure as the primary error and attaches disposal failure as suppressed information.

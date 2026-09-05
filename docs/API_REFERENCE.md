# `@syna/core` v0.5 API reference

Syna exposes immutable nominal descriptors and Entry-driven Env construction. Graph solving is global to the Runtime; TypeScript checks local shapes and descriptor compatibility. Every example below type-checks against `packages/core/src` (see `packages/core/type-tests/api.ts`).

## Package definition scope

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

`package.json#version` (a complete semver) is the exact version of every Service revision created by this scope. Contract, Input, Binding and Entry identities use an independent `apiVersion` (default `1`). `package.json` needs `"imports": { "#syna/package": "./package.json" }` and NodeNext module settings (`@syna/tsconfig/node-library.json`).

## Contract

```ts
interface Storage { read(key: string): Promise<Uint8Array> }
const Storage = define.contract<Storage>('storage', { apiVersion: 1, metadata: { displayName: 'Object Storage' } })
```

Dependency forms:

```ts
requires: {
  strict: Storage,          // exactly one implementation family, else AMBIGUOUS_IMPLEMENTATION
  automatic: auto(Storage), // Runtime policy chooses; MISSING_AUTO_POLICY without a policy
  all: Storage.all,         // every admitted implementation revision coexists in this Env
  legacy: Storage.selector, // @deprecated minimal compatibility; open() needs a Ready anchor
}
```

## Input

```ts
const CurrentRequest = define.input<Request>('current-request')
```

An Input is an external, lifecycle-free fact. An Entry parameter creates a new Input slot; omission inherits the nearest ancestor slot; explicitly providing the same payload again still creates a new slot; `undefined` is a value, a missing key is `MISSING_INPUT`.

### `InputRef<T>`

```ts
interface InputRef<T> {
  read(): T                          // synchronous; payload returned exactly as provided
  /** @deprecated */ load(): Promise<Awaited<T>>
}
```

`read()` never clones, freezes or awaits the payload: a Promise, thenable, function or `undefined` comes back by identity.

## Binding

```ts
const SummaryLlm = define.binding('summary-llm', Llm)
const ref = SummaryLlm.to(OpenAI)             // default range: ^<exact version> (0.2.0 → ^0.2.0, 0.0.5 → ^0.0.5)
const pinned = SummaryLlm.to(OpenAI, '>=2.4.0 <3 || 4.x')
const parsed = SummaryLlm.parse(json)          // validates shape and Contract id
```

Ranges are validated at definition time (`TypeError` for invalid ranges). Reassigning the same exact revision is a no-op; a different revision creates a new choice slot and forks its dependants.

## Service

```ts
const Repository = define.service('repository', {
  requires: { database: Database, request: CurrentRequest },
  provides: [RepositoryContract],
  eager: false,
  uniqueWithin: 'lineage',
  failure: { attempts: 3, delayMs: 100, afterExhaustion: 'retry-on-next-load', cooldownMs: 500 },
  setupDeadlineMs: 10_000,
  async setup({ database, request }, { signal, onDispose }) {
    const db = await database.load()
    const current = request.read()
    onDispose(() => db.releaseSomethingThisSetupCreated())   // never close a shared dependency
    return { /* opaque instance; must not be thenable */ }
  },
})
```

Options: `requires`, `provides`, `eager`, `uniqueWithin: 'lineage'`, `failure`, `setupDeadlineMs` (per-attempt initialization deadline, overrides the Runtime default; `Infinity` disables), `metadata`, `revisionMetadata`, `setup`.

### `DependencyRef<T>`

```ts
interface DependencyRef<T> {
  load(options?: { signal?: AbortSignal }): Promise<T>
  preload(): void
}
```

`load()` materializes the already-planned slot and returns a **plain Promise**. The Runtime attaches no barrier, no completion tracking and no obligation to the caller: `catch` for degraded mode, `Promise.race` fallbacks and un-awaited background loads behave as JavaScript defines. `signal` ends only this caller's wait (`LOAD_CANCELLED`); the shared attempt continues for other waiters. `preload()` starts the real slot in the background; its failure follows the slot's failure policy and is visible to later `load()` calls. A ref is never thenable: `Promise.resolve(ref)` yields the ref.

```ts
const { database, logger } = await loadAll({ database, logger })   // Service refs only; a catchable batch
```

### `ServiceRevision`

`family.id` (stable export identity), `version`, `key` (`family@version`), `requires`, `provides`, `eager`, `failure`, `setupDeadlineMs`, `metadata`, `setup`, `range(version = '*')`.

## Entry

```ts
const RequestEntry = define.entry('request', {
  requires: { handler: RequestHandler },
  parameters: { request: CurrentRequest, provider: SummaryLlm },
  scope: { fresh: [RequestCache.family], share: [Database] },
})
```

`requires` is the typed surface the caller receives (`env.deps`). `parameters` are Input provisions and Binding assignments. `scope.fresh`/`share` accept exact revisions or families; the planner computes the reverse dependency closure. Conflicts fail explicitly (`SHARE_CONSTRAINT_FAILED`, `CONSTRAINT_VIOLATION`).

## Runtime

```ts
const runtime = createRuntime({
  services: [Application, OpenAI, Claude],
  policy: { orderAutoCandidates(contract, candidates, context) { /* total order */ }, orderVersionCandidates(family, candidates, context) { /* ... */ } },
  overrides: [override(Postgres, FakePostgres)],
  planCache: { maxEntries: 512 },
  initialization: { deadlineMs: 30_000 },
  disposal: { graceMs: 2_000 },
  planning: { searchBudget: 10_000 },
  diagnostics: { onEvent: event => log(event) },
})
```

- `services`: the immutable public admission set. Exact transitive dependencies form private definition realms.
- `override(source, fake)`: construction-time definition override. Source keeps nominal identity, Contract membership, eagerness and metadata; the fake supplies `requires`/`setup`/`failure`/`setupDeadlineMs`. All resolution paths use the compiled view. Duplicate source, self and cycles are errors.
- `initialization.deadlineMs`: default per-attempt setup deadline → `INITIALIZATION_TIMEOUT` with `details.pendingLoads` and an optional `details.suspectedWaitCycle` (an observation, not a proof).
- `disposal.graceMs`: how long disposal waits for a timed-out attempt to settle before reporting it as abandoned (`UNSETTLED_ATTEMPT`).
- `planning.searchBudget`: candidate expansions per plan before `PLANNING_BUDGET_EXCEEDED`.
- `diagnostics.onEvent`: `late-setup-result`, `late-setup-failure`, `attempt-abandoned`, `foreign-thenable-setup`. Exceptions in the handler are ignored; diagnostics never change outcomes.

Methods:

```ts
runtime.enter(entry, parameters?)     // Promise<EnvHandle>
runtime.run(entry, parameters?, callback)
runtime.check(entry, parameters?)     // Promise<EntryCheck>  (plan only)
runtime.explain(entry, parameters?)   // Promise<EntryExplanation> (plan only)
runtime.inspect()                     // admitted/internal/overridden services, root/live env counts, plan cache stats, warnings
runtime.catalog.implementations(C) / resolve(ref) / revisions(familyId)   // read-only metadata
runtime.dispose(); await runtime[Symbol.asyncDispose]()
```

## Env

```ts
env.id; env.deps; env.state            // 'activating' | 'ready' | 'disposing' | 'disposed'
env.enter(entry, parameters?); env.run(...); env.check(...); env.explain(...)
env.derive({ fresh, share })
env.bind(entry)                        // BoundEntry anchored at this Env, public authority
env.inspect()                          // nodes with slot ids, owners and slot states
env.dispose(); await env[Symbol.asyncDispose]()
```

Entering from an Env that is still `activating` rejects with `OWNER_NOT_READY`; from a closing Env with `INVALID_ENV_STATE`. Activation failures are always `ENTRY_ACTIVATION_FAILED` with the underlying error as `cause` (and `details.causeCode` for SynaErrors).

### Ready and closing

An Env is Ready when every eager slot it owns is Ready; inherited eager slots are already Ready in their owner. Closing: refuse new work and abort the owner signal, wait for descendants, wait for registered attempts (up to the disposal grace), then dispose owned Ready slots dependant-first over the SCC condensation. Business and cleanup errors are both kept (`AggregateError`, or `error.suppressed` for `run()`).

## BoundEntry

A Service that requires an Entry receives a `BoundEntry` anchored at the **owner Env of the Service slot** (not at any caller). Its roots resolve in the owner's private realm (exact and range alike); Contract discovery stays public. `enter()`/`run()` need a Ready anchor; `check()`/`explain()` are pure and may run while the anchor activates.

```ts
const UnitOfWork = define.service('unit-of-work', {
  requires: { transaction: TransactionEntry },
  setup({ transaction }) {
    return { run: async (input, fn) => (await transaction.load()).run(input, async ({ tx }) => fn(await tx.load())) }
  },
})
```

## explain()

```ts
const explanation = await siteEnv.explain(RequestEntry, { request })
if (explanation.ok) {
  explanation.services   // { inherited, new, forked, eagerToStart, eagerInherited }
  explanation.inputs     // { inherited, provided }
  explanation.synthetic  // { inherited, new, forked }  (binding projections, collections, bound entries)
  explanation.choices    // site → revision key
  explanation.forks      // every non-inherited node with { cause, path }
} else {
  explanation.error, explanation.missingInputs, explanation.missingBindings
}
```

`ForkCause` kinds: `root`, `not-in-parent`, `fresh`, `input-provided`, `binding-changed`, `structure-changed`, `anchor-dependency-mismatch`, `dependency-forked` (with `via` edge and `dependency` node; `path` follows the chain to the terminal cause).

## Implementation collections

`C.all` yields an `ImplementationSet`: `candidates`, `resolve(persistentRef)`, `load(candidate | candidateRef | persistentRef, options?)`. Candidates are real nodes of the current Env; a `CandidateRef` belongs to one collection slot (`CONSTRAINT_VIOLATION` elsewhere). `PersistentImplementationRef` (`{ kind, contractId, implementationId, version }`) is JSON-safe; without the target family it fails with `MISSING_IMPLEMENTATION` — no supplier substitution.

## Errors

`SynaError` has `code` (`SynaErrorCode`) and `details`. Codes: `AMBIGUOUS_IMPLEMENTATION`, `CONSTRAINT_VIOLATION`, `DUPLICATE_DEFINITION`, `ENTRY_ACTIVATION_FAILED`, `INCOMPATIBLE_IMPLEMENTATION`, `INITIALIZATION_TIMEOUT`, `INVALID_DESCRIPTOR`, `INVALID_ENV_STATE`, `LINEAGE_UNIQUENESS_CONFLICT`, `LOAD_CANCELLED`, `MISSING_AUTO_POLICY`, `MISSING_BINDING`, `MISSING_IMPLEMENTATION`, `MISSING_INPUT`, `MISSING_SERVICE`, `OWNER_NOT_READY`, `PLANNING_BUDGET_EXCEEDED`, `RUNTIME_MISMATCH`, `SHARE_CONSTRAINT_FAILED`, `UNAVAILABLE_IMPLEMENTATION`, `UNSATISFIABLE_TOPOLOGY`, `UNSETTLED_ATTEMPT`. Diagnostics (`check`, `explain`, candidate availability) use the same union plus `UNKNOWN_ERROR`. Policy exceptions, invalid descriptors and budget exhaustion are never disguised as `UNSATISFIABLE_TOPOLOGY`.

## Platform

Node ≥ 22 (validated on 22/24 in CI configuration and 26 locally), TypeScript 5.9 strict with `exactOptionalPropertyTypes`, `lib: ES2022 + ESNext.Disposable`, real `@types/node`. `Symbol.asyncDispose` is used natively; no ambient async_hooks typing is involved because v0.5 uses no AsyncLocalStorage.

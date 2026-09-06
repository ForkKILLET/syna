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

`to()`/`parse()` produce an `ImplementationRef`, a JSON-safe preference: `{ kind: 'persistent-implementation-ref', contractId, familyId, version }`. `familyId` is the implementation family (`ServiceFamily.id`); 0.5 serialized the same value under the key `implementationId`, and `parse()` accepts either key (both, when equal) until 0.7.0 — see `docs/MIGRATION_V05_TO_V06.md`. A ref never points at an Env-local slot.

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

### `ServiceRef<T>`

```ts
interface ServiceRef<T> {
  load(options?: { signal?: AbortSignal }): Promise<T>
}
```

`load()` materializes the already-planned slot and returns a **plain Promise**. The Runtime attaches no barrier, no completion tracking and no obligation to the caller: `catch` for degraded mode, `Promise.race` fallbacks and un-awaited background loads behave as JavaScript defines. `signal` ends only this caller's wait (`LOAD_CANCELLED`); the shared attempt continues for other waiters. A background start is an un-awaited `load()` (`void ref.load().catch(() => undefined)`): it starts the real slot, its failure follows the slot's failure policy and is visible to later `load()` calls. A ref is never thenable: `Promise.resolve(ref)` yields the ref.

```ts
const { database, logger } = await loadAll({ database, logger })   // Service refs only; a catchable batch
```

### `ServiceRevision`

`family.id` (stable export identity), `version`, `key` (`family@version`), `requires`, `provides`, `eager`, `failure`, `setupDeadlineMs`, `metadata`, `setup`, `range(version = '*')`.

`Revision.range(version)` is a compatible-revision reference that carries its **origin**, the revision it was taken from. The Runtime chooses among the revisions of the Family it knows at the site — the admitted ones and, when the site resolves in a private realm (a Service-owned Entry, a private closure), the consumer's private closure and the origin itself; in the public realm only admitted revisions are candidates, so an internal origin referenced from a public root site is `MISSING_SERVICE` (D35) — that satisfy the range and provide every Contract the origin provides; when compatible revisions exist but none provides them the plan fails with `INCOMPATIBLE_IMPLEMENTATION` (`details.required`, `details.candidates`). Because another revision may be chosen, the ref types as the origin's **Contract view** (`ProvidedShape<Provides>`, `unknown` without `provides`), not as its instance type; an exact reference keeps the full instance type.

## Entry

```ts
const RequestEntry = define.entry('request', {
  requires: { handler: RequestHandler },
  parameters: { request: CurrentRequest, provider: SummaryLlm },
  reuse: { fresh: [RequestCache.family], share: [Database] },
})
```

`requires` is the typed surface the caller receives (`env.deps`). `parameters` are Input provisions and Binding assignments. Types: `EntryParameters<E>` is the declared parameter map (`E['parameters']`), `EntryArguments<E>` the call-time values record (one value per declared parameter), `EntryDependencies<E>` the `env.deps` shape and `EntryCallback<E, Result>` the `run` callback; `LoadedDependencies<Refs>` is the result of `loadAll`. `reuse.fresh`/`share` accept exact revisions or families (`ReuseTarget`); the planner computes the reverse dependency closure. The same constraints can be given per call as the separate options argument — `env.enter(RequestEntry, { request, provider }, { reuse: { fresh: [RequestCache.family] } })` — and definition-time and call-time targets are merged. Conflicts fail explicitly (`SHARE_CONSTRAINT_FAILED`, `FRESH_CONSTRAINT_FAILED`). `reuse` and `scope` are reserved parameter names. `scope` — in the definition, on the descriptor (`entry.scope === entry.reuse`) and as a key inside the parameter record — is the deprecated 0.5 form, removed in 0.7.0; one call may use one form, not both.

## Runtime

```ts
const runtime = createRuntime({
  services: [Application, OpenAI, Claude],
  policy: { orderAutoCandidates(contract, candidates, context) { /* total order */ }, orderVersionCandidates(family, candidates, context) { /* ... */ } },
  overrides: [override(Postgres, FakePostgres)],
  limits: { setupDeadlineMs: 30_000, disposalGraceMs: 2_000, planningBudget: 10_000, planCacheEntries: 512 },
  diagnostics: { onEvent: event => log(event) },
})
```

`createRuntime(options)` returns a `Runtime` (the 0.5 type name `SynaRuntime` is a deprecated alias, removed in 0.7.0).

- `services`: the immutable public admission set. Exact transitive dependencies form private definition realms.
- `override(source, fake)`: construction-time definition override. Source keeps nominal identity, Contract membership, eagerness and metadata; the fake supplies `requires`/`setup`/`failure`/`setupDeadlineMs`. All resolution paths use the compiled view. Duplicate source, self and cycles are errors.
- `policy`: `orderAutoCandidates(contract, candidates, context)` and `orderVersionCandidates(family, candidates, context)` return the candidates in preference order (a total order of the given list). `context.dependencySite` is the dependency site being resolved (`…/dependency:<name>` for a declared requirement, `…/persistent:<familyId>` for a resolved reference); `context.parentActiveRevisionKeys` are the revision keys active in the parent lineage. The 0.5 name `context.site` is a deprecated alias of `dependencySite` (removed in 0.7.0).
- `limits.setupDeadlineMs`: default per-attempt setup deadline → `INITIALIZATION_TIMEOUT` with `details.pendingLoads` and an optional `details.suspectedWaitCycle` (an observation, not a proof).
- `limits.disposalGraceMs`: how long disposal waits, after broadcasting the stop signal, for each in-flight setup attempt of the closing Env (running or already timed out) to settle before abandoning it. Slots of one Env wait concurrently, so each Env's own close is bounded by one grace period regardless of `setupDeadlineMs` (even `Infinity`); descendants close first, so a tree in which every level owns a stuck attempt closes in at most one grace per level. Abandoned attempts are reported as `UNSETTLED_ATTEMPT` (`details.slots[].dependencies` names the dependency slots each attempt may still use; they are closed in the normal order regardless; `details.slots[].phase` is `'setup'` while the raw Promise is pending and `'rollback'` when the setup had settled and its cleanups outlived the grace — the message says "still running", "still rolling back" or both). The Env then leaves the tree and the `inspect()` counts, keeps `state === 'disposing'` until the late result is cleaned up or the attempt is found unreachable, and the attempt is listed in `inspect().unsettledAttempts`.
- `limits.planningBudget`: candidate expansions per plan before `PLANNING_BUDGET_EXCEEDED`.
- `limits.planCacheEntries`: plan template cache capacity (`inspect().planCache` reports `hits`, `misses`, `entries`, `evictions`, `maxEntries`). The values shown above are the defaults. The 0.5 nested records `planCache: { maxEntries }`, `initialization: { deadlineMs }`, `disposal: { graceMs }` and `planning: { searchBudget }` are deprecated aliases of these four limits (removed in 0.7.0); a limit given in both forms is a `TypeError`.
- `diagnostics.onEvent`: `late-setup-result`, `late-setup-failure`, `attempt-abandoned`, `attempt-unreachable` (an abandoned or timed-out attempt whose setup Promise was garbage-collected: nothing can settle it any more, so its cleanups ran and the attempt is closed), `foreign-thenable-setup`. Exceptions in the handler are ignored; diagnostics never change outcomes.

Methods:

```ts
runtime.enter(entry, parameters?, options?)          // Promise<EnvHandle>; options: { reuse?: ReuseConstraints }
runtime.run(entry, parameters?, options?, callback)  // the callback is always the last argument
runtime.check(entry, parameters?, options?)          // Promise<EntryCheck>  (plan only)
runtime.explain(entry, parameters?, options?)        // Promise<EntryExplanation> (plan only)
runtime.inspect()                     // admitted/internal/overridden services, root/live env counts, plan cache stats, warnings,
                                      // unsettledAttempts: attempts timed out, abandoned, rolling back or settling late, held until they settle
                                      // (retention is bounded by the caller's own setup Promise; its collection closes the attempt as unreachable)
runtime.catalog.implementations(C) / resolve(ref) / revisions(familyId)   // read-only metadata
runtime.dispose(); await runtime[Symbol.asyncDispose]()
```

## Env

```ts
env.id; env.deps; env.state            // 'activating' | 'ready' | 'disposing' | 'disposed'
                                       // 'disposed' only once every attempt abandoned by this Env's close has settled
                                       // (its own and those of the descendants that close took down with it)
env.enter(entry, parameters?, options?); env.run(...); env.check(...); env.explain(...)
env.derive(reuse)                      // a child world with only reuse constraints ({ fresh, share })
env.anchor(entry)                      // AnchoredEntry anchored at this Env, public authority
env.inspect()                          // nodes with slot ids, owners and slot states
env.dispose(); await env[Symbol.asyncDispose]()
```

Entering from an Env that is still `activating` rejects with `OWNER_NOT_READY`; from a closing Env with `INVALID_ENV_STATE`. Activation failures are always `ENTRY_ACTIVATION_FAILED` with the underlying error as `cause` (and `details.causeCode` for SynaErrors).

### Ready and closing

An Env is Ready when every eager slot it owns is Ready; inherited eager slots are already Ready in their owner. Closing: refuse new work and abort the owner signal, wait for descendants, wait for registered attempts (up to the disposal grace), then dispose owned Ready slots dependant-first over the SCC condensation. Business and cleanup errors are both kept (`AggregateError`, or `error.suppressed` for `run()`); when the callback of `run()` succeeded and only the close reports, the close error carries the callback's result as a non-enumerable `result` property. The close is bounded by one grace period per level of the tree; when it ends the Env has left the tree whatever is still outstanding (see the lifecycle notes). `runtime.dispose()` waits up to `limits.disposalGraceMs` for attempts whose late cleanup is in progress (`settling`) and reports the rest.

## AnchoredEntry

A Service that requires an Entry receives an `AnchoredEntry` anchored at the **owner Env of the Service slot** (not at any caller). Its roots resolve in the owner's private realm (exact and range alike); Contract discovery stays public. `enter()`/`run()` need a Ready anchor; `check()`/`explain()` only plan (no setup, no Env, no anchor, no Env id or slot id consumed — their plans are numbered `check-slot-N` / `check-choice-N`; they register the descriptors they meet, diagnose a drifted copy of a definition as `DUPLICATE_DEFINITION` exactly as `enter()` would whether the plan is solved or taken from the cache, and may fill the plan cache, all bounded by the static definition set, see `inspect().definitions`) and may run while the anchor activates.

```ts
const UnitOfWork = define.service('unit-of-work', {
  requires: { transaction: TransactionEntry },
  setup({ transaction }) {
    return { run: async (input, fn) => (await transaction.load()).run(input, async ({ tx }) => fn(await tx.load())) }
  },
})
```

## Lifecycle notes

- `ref.load()` returns a Promise of its own for every caller (all callers share one attempt). A rejected Promise nobody handles is an ordinary unhandled rejection. `load({ signal })` with an already-aborted signal rejects with `LOAD_CANCELLED` and starts nothing.
- `onDispose(cleanup)` is accepted for as long as the setup attempt is still executing, including after its deadline passed or its owner started closing; the late-settlement cleanup then runs it. A lifecycle whose setup Promise already settled is stale and refused (`INVALID_ENV_STATE`).
- Closing an Env moves the whole subtree to `disposing` and aborts every descendant's `signal` first, then waits for descendants (sibling subtrees concurrently), then gives owned attempts `limits.disposalGraceMs`, then disposes owned Ready slots dependant-first (through never-started intermediates as well). `ServiceRef`s are bound to slots: a ref obtained from a child Env keeps working after that child is disposed as long as the slot's owner Env is alive.
- An attempt that ignores the signal past the grace is abandoned and reported (`UNSETTLED_ATTEMPT`); its dependencies are closed in the normal order anyway (the Runtime cannot revoke an instance it handed out) and the report names them. The Env then leaves the tree and the Runtime's registries, so its parent no longer waits for it and `inspect()` no longer counts it; its `state` stays `disposing` until the attempts settle late (cleaned up, `late-setup-*`) or become unreachable (`attempt-unreachable`). `inspect().unsettledAttempts` lists those attempts, held weakly: an attempt lives exactly as long as the caller's own setup Promise, never longer because of the Runtime. `runtime.dispose()` reports the ledger again if it is not empty.
- A failed rollback is final. When a cleanup throws (inside a retry sequence, or while a late result is cleaned up) the slot stays `failed` and every later `load()` rejects with `ROLLBACK_FAILED` (`cause`: the original error), even under `afterExhaustion: 'retry-on-next-load'`: the resources of that attempt are outside Syna's control and a new attempt would stack on top of them.
- A `load({ signal })` whose signal fires rejects the caller's own Promise with `LOAD_CANCELLED`; a later failure of the attempt it was waiting for is not turned into an unhandled rejection on that caller's behalf.

## explain()

```ts
const explanation = await siteEnv.explain(RequestEntry, { request })
if (explanation.ok) {
  explanation.services   // { inherited, new, forked, eagerToStart, eagerInherited }
  explanation.inputs     // { inherited, provided }
  explanation.synthetic  // { inherited, new, forked }  (binding projections, collections, anchored entries)
  explanation.choices    // site → revision key
  explanation.forks      // every non-inherited node with { cause, path }
} else {
  explanation.error, explanation.missingInputs, explanation.missingBindings
  // missing ids are collected wherever they occur: declared Entry parameters, requirements deep
  // inside the graph, and the per-candidate failures of an UNSATISFIABLE_TOPOLOGY report
}
```

`ForkCause` kinds: `root`, `not-in-parent`, `fresh`, `input-provided`, `binding-changed`, `structure-changed`, `anchor-dependency-mismatch`, `dependency-forked` (with `via` edge and `dependency` node; `path` follows the chain to the terminal cause).

## Implementation collections

`C.all` yields an `ImplementationSet`: `candidates`, `resolve(ref)`, `load(candidate | candidateRef | ref, options?)` (`ref`: an `ImplementationRef`). Candidates are real nodes of the current Env; a `CandidateRef` belongs to one collection slot (`FRESH_CONSTRAINT_FAILED` elsewhere). `ImplementationRef` (`{ kind, contractId, familyId, version }`) is JSON-safe; without the target family it fails with `MISSING_IMPLEMENTATION` — no supplier substitution.

## Errors

`SynaError` is a union discriminated by `code`: `SynaError<'MISSING_INPUT'>` is one member, `SynaError` all of them. `isSynaError(error, code)` narrows to one member and `error.code === code` narrows `details` in a `switch`; `SynaErrorDetails[Code]` names the `details` type of a code (`SynaErrorDetails` is exported). `details` is frozen. Diagnostics (`check`, `explain`) use the same union plus `UNKNOWN_ERROR` (`DiagnosticCode`). Policy exceptions, invalid descriptors and budget exhaustion are never disguised as `UNSATISFIABLE_TOPOLOGY`.

| Code | Thrown when | `details` |
|---|---|---|
| `AMBIGUOUS_IMPLEMENTATION` | a bare Contract dependency has several implementation Families at a site | `{ contract, site, families: string[] }` |
| `DUPLICATE_DEFINITION` | two definitions of one Family, Binding, Entry or revision disagree structurally, or a Service is overridden twice | `{ existing, received }` (Family) · `{ revision }` (override) · `{ revision, expected, actual }` (manifest) |
| `ENTRY_ACTIVATION_FAILED` | `enter()` fails while activating; the underlying error is `cause` | `{ entry, env, causeCode?, causeDetails? }` |
| `FRESH_CONSTRAINT_FAILED` | a `fresh`/`share` target is inactive in the parent, an inherited choice is invalid at a site, or a `CandidateRef` belongs to another collection | `{ env, revision }` · `{ env, family }` · `{ site, selectedKey, candidates: string[] }` · `{ expectedSourceSlot, receivedSourceSlot }` |
| `INCOMPATIBLE_IMPLEMENTATION` | an implementation reference or assignment names a revision that does not provide the required Contract, or no range candidate covers the origin's Contracts | `{ binding, contract, reference }` · `{ binding, revision }` · `{ contract, reference }` · `{ family, range, site, realm, origin, required: string[], candidates: { revision, provides: string[] }[] }` |
| `INITIALIZATION_TIMEOUT` | a setup attempt exceeds `limits.setupDeadlineMs` | `{ slot, revision, env, attempt, deadlineMs, elapsedMs, pendingLoads: { revision, slot, state, waitingMs }[], suspectedWaitCycle?: string[], note }` |
| `INVALID_DESCRIPTOR` | a descriptor, option or policy result has the wrong shape | `{ site?, binding?, revision?, original?: string[], ordered?: string[] }` |
| `INVALID_ENV_STATE` | an operation meets an Env, slot or Runtime in a state that forbids it (closed, disposing, exhausted, aborted) | `{ env?, entry?, state?, node?, slot?, revision?, attempt? }` |
| `LINEAGE_UNIQUENESS_CONFLICT` | a lineage-unique Family would diverge below its anchor or occupy several slots in one lineage | `{ family, anchorRevision, anchorSlot, attempted: { revision, slot, cause, path: string[] }[] }` · `{ family, slots: string[] }` |
| `LOAD_CANCELLED` | the caller's `signal` aborts a `load()` wait | `{ slot, revision }` |
| `MISSING_AUTO_POLICY` | `auto(C)` meets several Families and the Runtime has no `policy` | `{ contract, site, families: string[] }` |
| `MISSING_BINDING` | a Binding is required at a site but chosen nowhere in the lineage, or an Entry call omits a declared Binding parameter | `{ binding, site, missing: string[] }` · `{ entry, missing, missingInputs, missingBindings }` |
| `MISSING_IMPLEMENTATION` | no admitted Service implements a Contract, or an implementation reference names a Family, version or candidate the Runtime does not have | `{ binding, implementation, version, available: string[] }` · `{ contract, site }` · `{ contract, implementation, version, available? }` · `{ revision }` |
| `MISSING_INPUT` | an Input is required at a site but provided nowhere in the lineage, or an Entry call omits a declared Input parameter | `{ input, site, missing: string[] }` · `{ entry, missing, missingInputs, missingBindings }` |
| `MISSING_SERVICE` | a revision is unknown or not admitted, is outside the private realm at a site, or no visible revision satisfies a range | `{ revision }` · `{ binding, revision }` · `{ revision, site, realm }` · `{ family, range, site, realm }` |
| `OWNER_NOT_READY` | `enter()` from an Env that is still `activating` | `{ entry, env, state }` |
| `PLANNING_BUDGET_EXCEEDED` | planning exhausts `limits.planningBudget` (a limit, not a proof) | `{ site, budget }` |
| `ROLLBACK_FAILED` | a recovery is refused because the previous attempt's rollback failed | `{ slot, revision, state }` |
| `RUNTIME_MISMATCH` | an anchor belongs to another Runtime | `{}` |
| `SHARE_CONSTRAINT_FAILED` | a `share` target cannot reuse its parent-visible slot | `{ revision, env, cause, path: string[] }` |
| `UNSATISFIABLE_TOPOLOGY` | every candidate at a site fails; `failures` lists each attempt | `{ site, candidates: string[], failures: { code, message, details }[] }` |
| `UNSETTLED_ATTEMPT` | a Runtime or Env closes while setup attempts are still running or rolling back, or a timed-out attempt is still running when a new one is requested | `{ attempts }` (Runtime) · `{ env, state, slots: { slot, revision, attempt, phase, dependencies }[] }` (Env) · `{ slot, revision, attempt, runningForMs }` |

## Platform

Node ≥ 22 (validated on 22/24 in CI configuration and 26 locally), TypeScript 5.9 strict with `exactOptionalPropertyTypes`, `lib: ES2022 + ESNext.Disposable`, real `@types/node`. `Symbol.asyncDispose` is used natively; no ambient async_hooks typing is involved because v0.5 uses no AsyncLocalStorage.

## Deprecated in 0.6, removed in 0.7.0

Every 0.5 name below still works in 0.6.x exactly as before (same object or a forwarding alias, same checks) and is flagged `@deprecated` in the type declarations. `docs/MIGRATION_V05_TO_V06.md` gives the reason for each rename; `docs/API_STABILITY.md` states the deprecation policy.

| 0.5 | 0.6 | Notes |
|---|---|---|
| `EntryDefinition.scope`, `EntryDescriptor.scope` | `reuse` | `descriptor.scope` is a non-enumerable alias of `descriptor.reuse`; a definition may not give both |
| `scope` inside the parameter record of `enter`/`run`/`check`/`explain` | the separate options argument `{ reuse }` | one call may use one form, not both; `reuse` is never a parameter key |
| `DeriveOptions` | `ReuseConstraints` | type alias |
| `ScopeTarget` | `ReuseTarget` | type alias |
| `env.bind(entry)` | `env.anchor(entry)` | same result object shape and checks; `bind` forwards to `anchor` |
| `BoundEntry` | `AnchoredEntry` | type alias |
| `SynaRuntime` | `Runtime` | type alias; the only branded type name is `SynaError` |
| `PersistentImplementationRef` | `ImplementationRef` | type alias; `ImplementationDescriptor.persistentRef` keeps its name (`ImplementationCandidate.ref` is the CandidateRef) |
| `ref.implementationId` | `ref.familyId` | serialized key changes to `familyId`; `implementationId` stays readable (not enumerable); `parse()` accepts both keys |
| `planCache: { maxEntries }`, `initialization: { deadlineMs }`, `disposal: { graceMs }`, `planning: { searchBudget }` (types `PlanCacheOptions`, `InitializationOptions`, `DisposalOptions`, `PlanningOptions`) | `limits: { planCacheEntries, setupDeadlineMs, disposalGraceMs, planningBudget }` (`RuntimeLimits`) | each old key maps to one limit; both forms for one limit is a `TypeError`; defaults unchanged (30_000 / 2_000 / 10_000 / 512) |
| `RuntimePolicyContext.site` | `dependencySite` | the same string; `site` is a non-enumerable getter on the context object |
| `DependencyRef<T>` (the loadable ref) | `ServiceRef<T>` | in 0.6 `DependencyRef<T>` means `ServiceRef<T> \| InputRef<T>`; narrow with `'load' in ref` or type the variable as `ServiceRef` |

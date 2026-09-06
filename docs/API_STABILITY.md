# `@syna/core` API stability (v0.7)

This document declares what is frozen from 0.6.0 on and what 0.7.0 did to it, how deprecated names are retired, the naming rules every later addition must follow, and — from 0.7.0 — the surface that is the candidate for 1.0. It is the reference for `docs/MIGRATION_V05_TO_V06.md` and `docs/MIGRATION_V06_TO_V07.md` (what changed and why), `docs/SEMANTIC_CHANGES_V07.md` (what 0.7 keeps, clarifies, revises and withdraws) and `docs/DEFERRED.md` (what was deliberately not changed).

## 1.0 candidate surface (1.0 候选面)

From 0.7.0 the frozen surface below is the **1.0 candidate surface**: the public API recorded by `scripts/api-inventory.mjs` (`work/v07/API_INVENTORY_AFTER.json`; 0 `@deprecated` items, asserted by the release gate), the 26 error codes with the `details` shapes of `docs/API_REFERENCE.md`, every `RuntimeEvent.type`, `EnvState`, the `limits` defaults, and the semantics of `docs/SEMANTIC_MODEL.md` as revised by 0.7.0 (§11, §13; `docs/SEMANTIC_CHANGES_V07.md`). The declaration:

- 1.0 adds no name to this surface, removes none and changes no semantics of it. Every deprecation minor the 0.6 line announced has been executed (the register is empty); nothing on this surface is scheduled for removal.
- After 0.7.0 any change to a public name or to a semantic of this surface needs a **major**: a removal or a semantic change goes through a deprecation minor first, as the policy below says, and lands in the next major.
- Not on the candidate surface, and therefore not promised for 1.0 in either direction: everything `docs/DEFERRED.md` lists (`C.all` coexistence relaxation, `primary()`, `ServiceFamily.range()`, `load({ timeoutMs })`, cross-ancestor reuse, Prepared / activation groups, a generation-switching host). An addition of that kind is a new name under the naming guidelines, not a change of this surface.
- Persisted data is separate from the API line: the 0.5 serialized key `implementationId` is read permanently (deprecation policy below), and `kind: 'persistent-implementation-ref'` never changes.

## Frozen surface

The names below are stable: they are not renamed, aliased or re-typed within a minor line, and a later major that touches one of them must give the old name a deprecation minor first (see the policy). Semantics are frozen with the names. 0.6 froze them exactly as 0.5 had them; 0.7.0 revised three of them — S1 (the setup deadline is the waiter's timeout), S2 (`env.state` is advanced only by Runtime actions; the ledger is decoupled from garbage collection; `dispose()` does not reject for an abandoned attempt) and S6 (`FRESH_CONSTRAINT_FAILED` split by throw site) — and clarified three (S7, S8, S10: codes and `details`, never trigger conditions or messages); everything else — defaults, error trigger conditions, `explain()` content, plan-cache behaviour, the `C.all` coexistence requirement, the absence of default implementations, the planning layer as a whole — is exactly that of 0.5 (`packages/core/tests/v06-snapshots.test.mjs`, `reference-planner.test.mjs`; `docs/SEMANTIC_CHANGES_V07.md`).

Kept from 0.5 (every one considered and confirmed):

- Definition: `definePackage`, `define.service` / `contract` / `input` / `binding` / `entry`, `requires`, `provides`, `parameters`, `eager`, `uniqueWithin: 'lineage'`, `failure: { attempts, delayMs, afterExhaustion, cooldownMs }`, `setupDeadlineMs` (as the Service option), `metadata` / `revisionMetadata`, `setup(deps, { signal, onDispose })`.
- Dependency forms: `auto()`, `forward()`, `override()`, `Service.range()`, `Contract.all`, `ImplementationSet` with `candidates` / `resolve` / `load`, `CandidateRef`, `Binding` with `Binding.to()` / `parse()`, `Input` / `InputRef.read()`, `load()`, `loadAll()`.
- Worlds: `Entry`, `EnvHandle`, `EnvState`, `env.deps`, `enter` / `run` / `check` / `explain` / `derive` / `inspect` / `dispose`, `catalog.implementations` / `resolve` / `revisions`, `defaultRuntimePolicy`, `ExplainedNode.disposition` and every `ForkCause.kind`, every `RuntimeEvent.type`, the 19 error codes other than the renamed one, the one split by meaning in 0.7.0 (`ENV_CLOSED` / `RUNTIME_CLOSED` / `SLOT_NOT_LOADABLE` / `LIFECYCLE_MISUSE`, `docs/MIGRATION_V06_TO_V07.md` §3) and the one removed in 0.7.0 with the close semantics (`UNSETTLED_ATTEMPT`: an attempt that outlives a close is a ledger entry and an event, not an error): `AMBIGUOUS_IMPLEMENTATION`, `DUPLICATE_DEFINITION`, `ENTRY_ACTIVATION_FAILED`, `INCOMPATIBLE_IMPLEMENTATION`, `INITIALIZATION_TIMEOUT`, `INVALID_DESCRIPTOR`, `LINEAGE_UNIQUENESS_CONFLICT`, `LOAD_CANCELLED`, `MISSING_AUTO_POLICY`, `MISSING_BINDING`, `MISSING_IMPLEMENTATION`, `MISSING_INPUT`, `MISSING_SERVICE`, `OWNER_NOT_READY`, `PLANNING_BUDGET_EXCEEDED`, `ROLLBACK_FAILED`, `RUNTIME_MISMATCH`, `SHARE_CONSTRAINT_FAILED`, `UNSATISFIABLE_TOPOLOGY`).

New in 0.6 (the replacements; frozen from 0.6.0):

| Item | Frozen names |
|---|---|
| R1 | `reuse: { fresh, share }` on Entry definitions and descriptors; the call options record `{ reuse }` of `enter` / `run` / `check` / `explain` (`EntryOptions`); `ReuseConstraints`, `ReuseTarget` |
| R2 | `env.anchor(entry)`, `AnchoredEntry` |
| R3 | `Runtime` |
| R4 | `ServiceRef<T>` (the loadable ref), `InputRef<T>` |
| R5 | `ImplementationRef` with the serialized key `familyId`; `ImplementationDescriptor.persistentRef` keeps its name |
| R6 | `RuntimePolicyContext.dependencySite` |
| M1 | `limits: { setupDeadlineMs, disposalGraceMs, planningBudget, planCacheEntries }` (`RuntimeLimits`) with the defaults 30_000 / 2_000 / 10_000 / 512 |
| M2 | `EntryParameters<E>` (the declared parameter map), `EntryArguments<E>` (the call-time values), `LoadedDependencies<Refs>` |
| M3 | `FRESH_CONSTRAINT_FAILED` — split in 0.7.0 by throw site into `INACTIVE_REUSE_TARGET`, `INVALID_INHERITED_CHOICE` and `FOREIGN_CANDIDATE_REF` (`docs/MIGRATION_V06_TO_V07.md` §3) |
| T1 | `SynaError<Code>` (a union discriminated by `code`), `SynaErrorOf<Code>`, `SynaErrorDetails`, `isSynaError(error, code?)`, `SynaErrorCode`, `DiagnosticCode` |
| T2 | the single phantom field `__type` (type-level only; never documented as an API, never present at runtime) |

Removed in 0.6.0 without alias (D items): `ServiceRef.preload()`, `InputRef.load()`, `Contract.selector` with `ImplementationSelector`, `ImplementationSelectorDependency`, `ImplementationLease`, the inspection node kind `'selector'` and the error code `UNAVAILABLE_IMPLEMENTATION`, and `serviceRange()`. They are not coming back under another name.

Changed in 0.7.0 (`docs/MIGRATION_V06_TO_V07.md`; frozen from 0.7.0 as part of the candidate surface):

| Item | 0.7.0 |
|---|---|
| §2.1 / §2.2 | The 23 aliases of the 0.6 line, the 0.5 call form (`scope` inside the parameter record) and the selector remnants `ImplementationCandidate.availability` / `CandidateAvailability` / `AvailableImplementationCandidate` are removed; an expired form given at runtime is a `TypeError` naming the current form |
| S6 | `INACTIVE_REUSE_TARGET`, `INVALID_INHERITED_CHOICE`, `FOREIGN_CANDIDATE_REF` replace `FRESH_CONSTRAINT_FAILED` (removed) |
| S7 | `ENV_CLOSED`, `RUNTIME_CLOSED`, `SLOT_NOT_LOADABLE`, `LIFECYCLE_MISUSE` replace `INVALID_ENV_STATE` (removed); `INVALID_DESCRIPTOR.details` is `{ descriptor, problem, site?, path? }` |
| S8 | `MISSING_IMPLEMENTATION.details` is one of three shapes with every field required |
| S1 | `INITIALIZATION_TIMEOUT.details.attemptStillRunning: true`; `RuntimeEvent` `attempt-overdue`; `late-setup-result.adopted`; `EnvInspectionNode.overdueMs?` |
| S2 | `EnvInspection.abandonedAttempts`; `RuntimeEvent` `attempts-outstanding`; `attempt-abandoned.dependencies`; `UNSETTLED_ATTEMPT` removed (no throw site) |
| R5 (data) | `RuntimeEvent` `legacy-implementation-ref`: each Runtime read of the 0.5 serialized key is reported once |

## Deprecation policy

- A name that is deprecated keeps working for **one minor** with the same object or a forwarding alias, the same checks and the same errors as the new name, and is removed in the next minor. The 23 aliases the 0.6 line carried were removed in **0.7.0** (`docs/MIGRATION_V06_TO_V07.md` §1 lists each with its replacement and what happens to code that still spells it: a missing export or an excess property at compile time, a `TypeError` that names the current form at runtime — never a silently ignored option).
- Every deprecated declaration carries `@deprecated Use \`<new name>\`. Removed in <version>.` in `dist/*.d.ts`; `scripts/tests/deprecations.test.mjs` keeps the register of deprecated items and fails if anything outside it is deprecated. From 0.7.0 the register is empty: no public item is deprecated, and `scripts/tests/api-inventory.test.mjs` asserts the count is 0.
- A deprecated alias is never the migration path for code in this repository: applications, demos, benchmarks and scripts use the current names only (`scripts/tests/no-old-names.test.mjs`, which also scans the core source for the deleted public names).
- Persisted data outlives API lines: a serialized key that changed (R5, `implementationId` → `familyId`) is *written* in the new form from 0.6.0 and *read* in both forms permanently. From 0.7.0 each Runtime read of the old form is reported as the diagnostics event `legacy-implementation-ref`, so stored documents can be rewritten at leisure; `kind: 'persistent-implementation-ref'` is the stable discriminator and never changes.

## Naming guidelines

For every API added after 0.6.0:

1. **Descriptors are nouns.** `Contract`, `Input`, `Binding`, `Entry`, `ServiceRevision`, `ServiceFamily`, `ImplementationRef`, `CandidateRef`, `AnchoredEntry`: a descriptor names a thing, never an action.
2. **A verb's cost is visible in its name.** `load` may trigger a setup (and therefore wait, fail and retry); `read` never does anything but return the payload; `enter` creates a world; `check` and `explain` never create one. Do not add a verb whose cost the reader cannot tell from the name, and do not reuse one of these verbs for a different cost.
3. **No internal terms on the call surface.** Slots, realms, the internal meaning of lineage anchors and materialization stay in `internal/` and in `inspect()` output, not in method or option names. `anchor` is the one public exception: the Env an `AnchoredEntry` is anchored at is a user-facing concept.
4. **One name per concept.** A concept with two names is a defect (reason 3 of the migration document); the second name is removed, not aliased, unless it is an existing public name that then follows the deprecation policy.
5. **Rare options may be verbose; hot paths must be the shortest.** `limits.setupDeadlineMs` and `reuse: { fresh: [...] }` are read rarely; `load()`, `read()`, `enter()`, `run()` and `env.deps` are typed on every call.
6. **Do not collide with Syna's own vocabulary or with the industry's** (reasons 1 and 2): a new name may not share its root with `Binding`, `Service`, `Input`, `Entry`, `Env`, `Runtime` unless it names that thing, and may not carry a meaning the industry attaches to a different thing (`scope`, `lease`, `selector`, `session`).

Prohibited by this document: a third name between an old and a new one; an alias for a name outside a migration; a deprecation that names no replacement or no removal version.

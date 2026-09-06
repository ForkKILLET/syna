# Syna v0.7 — Phase A proposal (review point)

Task book: `SYNA_V07_EXECUTION_PROMPT.md` (untracked at the workspace root; never committed). Baseline: 0.6.0 at commit 582c93a (final v0.6 gate COMPLETE on f019402, evidence 582c93a; `work/v06/STATE.md`). Nothing below is implemented yet: this is the document §3 Phase A asks for, and the work stops here for review.

The document follows the task-book items. Every point where the task book leaves a choice open, or where I recommend deviating from its literal wording, is marked **Q<n>** and collected in §12 with a recommendation. Everything not marked is a straight reading of the task book.

## 1. Inventory and the deletion list (§2.1, §2.2)

`node scripts/api-inventory.mjs --out work/v07/API_INVENTORY_BEFORE.md --json work/v07/API_INVENTORY_BEFORE.json` regenerated on 582c93a: 103 exports, 244 members, 40 union members, 387 items, **23 `@deprecated` items**. Apart from the `commit` field the JSON is identical to `work/v06/API_INVENTORY_AFTER.json` (verified with a field-by-field diff).

The 23 deprecated items against §2.1 (every row of the task-book table is matched; nothing else is deprecated):

| §2.1 group | Deprecated items in the inventory | Count |
|---|---|---|
| Env / Entry | `EnvHandle.bind`, `BoundEntry`, `EntryDefinition.scope`, `EntryDescriptor.scope`, `DeriveOptions`, `ScopeTarget` | 6 |
| Runtime | `SynaRuntime`; `CreateRuntimeOptions.planCache` / `.initialization` / `.disposal` / `.planning`; `PlanCacheOptions` + `.maxEntries`; `InitializationOptions` + `.deadlineMs`; `DisposalOptions` + `.graceMs`; `PlanningOptions` + `.searchBudget`; `RuntimePolicyContext.site` | 14 |
| Ref | `DependencyRef`, `PersistentImplementationRef`, `ImplementationRef.implementationId` | 3 |

The 0.5 call form `ScopedEntryParameters` (the `scope` key inside the parameter record and the corresponding overload branches of `EntryCallArguments` / `EntryRunCallArguments`) is a module-internal type in `descriptors.ts`, so the inventory does not list it; it is deleted with the group (the overload branches go; `entryCall()` in `runtime.ts` stops lifting `scope`).

Where each deletion lives (for the Phase B commit):

| Item | Source | Runtime mechanics removed |
|---|---|---|
| `EntryDefinition.scope`, `EntryDescriptor.scope` | `descriptors.ts`; `definition.ts` (`withDeprecatedScope`, the "both `reuse` and `scope`" TypeError); `runtime.ts` (`internalDeriveEntry`) | non-enumerable getter; definition-time alias |
| parameter-record `scope` | `descriptors.ts` (`ScopedEntryParameters` and its overload branches); `runtime.ts` (`entryCall`) | lifting into `reuse`; the "both forms" TypeError |
| `DeriveOptions`, `ScopeTarget`, `BoundEntry`, `SynaRuntime`, `DependencyRef`, `PersistentImplementationRef`, the four option interfaces | `descriptors.ts`, `index.ts` | type aliases |
| `EnvHandle.bind` | `descriptors.ts`; `runtime.ts` (`EnvImpl.bind`) | forwarder |
| `CreateRuntimeOptions.planCache/initialization/disposal/planning` | `descriptors.ts`; `runtime.ts` (`resolveLimits`, `pick()`) | mapped options; the "both forms" TypeError |
| `RuntimePolicyContext.site` | `descriptors.ts`; `internal/runtime-model.ts` (`PolicyContext` `site` getter) | prototype getter |
| `ImplementationRef.implementationId` (runtime getter) | `definition.ts` (`createImplementationRef`, `normalizeImplementationRef`); `descriptors.ts` | non-enumerable getter on produced refs |

Two behaviours after the deletion that the task book does not spell out:

- **Q1 — a `scope` key in the call-time parameter record.** No Entry can declare a parameter named `scope` (`reuse` and `scope` stay reserved parameter ids; lifting the reservation would be a semantic change outside the list). I propose that a `scope` key in the record is refused with a `TypeError` naming the replacement (`scope is no longer a call parameter; pass { reuse } as the options argument`), exactly as a `reuse` key in the record is refused in 0.6, rather than reaching the planner as an unknown key. Silently ignoring an expired form is the one outcome a deletion must not have.
- **`implementationId` as a persisted JSON key** is *not* deleted (task book §2.1, permanent data compatibility) — see §8.

§2.2 remnants:

- `ImplementationCandidate.availability` and `CandidateAvailability`: deleted; `ImplementationCandidate` keeps `ref` and the `ImplementationDescriptor` fields. The only producer is `implementation-directory.ts:209` (`availability: { status: 'available' }`); no application, demo, benchmark, script or test reads the field (grep of `apps/*/src`, `packages/hyla/src`, `benchmarks`, `scripts`, `apps/*/tests`, `packages/core/tests`: zero hits; the only mention outside `packages/core/src` is an archived 0.5 audit probe under `docs/audit/`, which is historical evidence and stays).
- **Q2 — `AvailableImplementationCandidate`** (exported type, `ImplementationCandidate & { availability: { status: 'available' } }`, `descriptors.ts:377`) is the third selector remnant: it is defined *by* `availability` and becomes `ImplementationCandidate & {}` once the field is gone. It is not in the task-book table; I propose deleting it in the same commit (grep: no use anywhere outside `descriptors.ts` / `index.ts`) rather than keeping a name that means nothing.
- `RuntimeEvent`: every one of the five types has a producer in `materializer.ts` (`late-setup-result`, `late-setup-failure`, `attempt-abandoned`, `attempt-unreachable`, `foreign-thenable-setup`: one `onEvent` call each). Nothing selector-only exists; nothing to delete.
- Docs: `docs/API_REFERENCE.md` and `docs/ARCHITECTURE.md` contain no `selector` / `lease` / `availability` / pre-check wording (grep). `docs/DEFERRED.md` N2 is the `availability` entry and goes with the field. `docs/MIGRATION_V05_TO_V06.md` and `SEMANTIC_CHANGES_V05.md` are historical records and stay.

## 2. S1 — the deadline is the waiter's timeout

### 2.1 Slot state machine (0.7)

```text
             load() on dormant                       raw setup resolves, owner activating/ready
Dormant ────────────────────────▶ Starting ────────────────────────────────────────────▶ Ready ──▶ Disposing ──▶ Disposed
                                  │  ▲  │
  a waiter's deadline expires ───▶│  │  │   slot state unchanged; attempt.overdueAt set on the first expiry;
  (per waiter; the attempt        │  │  │   one `attempt-overdue` event per attempt; inspect() reports overdueMs;
   keeps running)                 │  │  │   ledger lists the attempt as `timed-out` (Q3)
                                  │  │  │
  raw setup rejects ──────────────┘  │  └──▶ Failed ──(recovery after cooldownMs)──▶ Starting
  (cleanups run; next attempt in the │        │  (final once a rollback failed: ROLLBACK_FAILED)
   same sequence if attempts remain, │        │
   after delayMs; else Failed)       │        │
                                     │        │
  owner Env closes while Starting ───┴────────┴──▶ Abandoned ──(late settlement / unreachable)──▶ Disposed
  (abort → grace → abandoned: the late result is discarded and cleaned up)
```

Compared with 0.6 the only removed transition is `Starting → Failed` **by deadline**. A deadline never changes a slot state; it only ends one waiter's wait. The overdue mark is a property of the running attempt, not a state.

### 2.2 Waiters and attempts

| | 0.6 | 0.7 |
|---|---|---|
| What `setupDeadlineMs` bounds | one attempt (`raceDeadline` inside `runAttempt`) | one `load()` wait on the current attempt (S1.1); the Service option and `limits.setupDeadlineMs` keep their meaning and default (30_000, locked by test) |
| Deadline expires | slot `failed`, attempt `timed-out`, `unsettledAttempt` set; late result discarded + cleaned up | the waiter rejects with `INITIALIZATION_TIMEOUT` (existing fields + `attemptStillRunning: true`); slot stays `starting`; the attempt keeps running |
| Later `load()` | sticky → the timeout error; `retry-on-next-load` → `UNSETTLED_ATTEMPT` | joins the running attempt with its own window (S1.3) |
| Late success, owner `ready` | discarded, cleanups run, `late-setup-result` | adopted: slot `ready`, every remaining waiter fulfils, `late-setup-result` with `adopted: true` (S1.4) |
| Late failure | `late-setup-failure`, slot already `failed` | the existing failure path verbatim (cleanups; retry with `delayMs` if attempts remain; sticky / `retry-on-next-load`); `late-setup-failure` reported because the attempt was overdue (S1.5) |
| Owner closes during the attempt | abort → grace → abandoned → late result discarded + cleaned up | unchanged verbatim; the only way a late success is discarded (S1.6) |
| `attempts` / `delayMs` | a timeout consumed one attempt and triggered the backoff | a timeout consumes nothing and triggers nothing: the attempt counter grows only when `setup()` is actually called (S1.5) |

**Waiter window (Q11).** A waiter's timer is armed when its wait starts if an attempt is running, and re-armed whenever a *new* attempt starts; it is cleared while the sequence is between attempts (the `delayMs` backoff). So the window is "this waiter's wait on the *current attempt*" (the task-book wording of S1.1), and a waiter can wait up to `attempts × deadline` plus the backoffs, exactly as a waiter on the 0.6 sequence could. The alternative reading, one window per `load()` regardless of retries, would time a waiter out while a *fresh* attempt is running and would report `elapsedMs` (the attempt's elapsed time, an existing field) shorter than the deadline; I recommend the per-attempt reading. A waiter that joins during the backoff is armed when the next attempt starts. `Infinity` arms nothing. `load({ signal })` ends a wait as before (`LOAD_CANCELLED`) and is the documented way to wait less than the deadline (`AbortSignal.timeout()`), which goes into API_REFERENCE as S1.8 asks; no public option is added.

Implementation (all inside `internal/materializer.ts`, internal types in `runtime-model.ts`): `raceDeadline` loses its timer (it races the raw Promise against `attempt.abandoned` only); `loadService()` returns a per-waiter Promise from a `slot.waiters` set instead of the shared `slot.sequence`; `createAttempt()` re-arms every waiter and the end of `runAttempt()` disarms them; the requester's `pendingLoads` record is tied to the waiter's own Promise (removed when that wait ends, including by timeout), so the wait-cycle observation (`suspectedWaitCycle`) is unchanged: the first timer to fire, the user's own waiter, still sees both pending loads.

Events and inspection:

- `attempt-overdue` (new `RuntimeEvent` member, mandated by S1.2): `{ type: 'attempt-overdue', slot, revision, env, attempt, deadlineMs, elapsedMs }`, emitted once per attempt when its first waiter times out.
- `late-setup-result` gains `adopted: boolean` (mandated by S1.4): `true` for an adopted late success (then `cleanupErrors` is `[]`), `false` when a close discarded the result.
- `late-setup-failure` is emitted when an overdue attempt fails (also after a close, as today).
- `env.inspect().nodes[i].overdueMs?: number` (mandated by S1.2): present only while the slot is `starting` and its attempt is overdue; `now − overdueAt`, `overdueAt` being the first waiter timeout on the attempt. Absent otherwise, so the fixed-world snapshot is untouched.
- `INITIALIZATION_TIMEOUT.details`: every existing field keeps its meaning (`elapsedMs` is the attempt's elapsed time, `attempt` the running attempt's number, `pendingLoads` / `suspectedWaitCycle` as today) plus `attemptStillRunning: true`; the `note` text changes from "its result will be discarded and reported" to "the attempt keeps running; its result is adopted if the owner Env is still ready, and discarded only if the owner closes".
- **Q3 — the ledger.** Today `runtime.inspect().unsettledAttempts` lists a timed-out attempt as `timed-out` while its owner lives (`R-1` asserts `['timed-out', 'timed-out']`). I propose to keep that: an overdue attempt enters the ledger as `timed-out` at its first waiter timeout and leaves it when it settles (adopted or failed) or is converted to `abandoned` by a close. This keeps the `UnsettledAttemptInspection.state` union unchanged and keeps the ledger's definition ("attempts the Runtime is still waiting on past a deadline or a close") true. The alternative — listing only abandoned attempts — would delete the union member `'timed-out'` (a public name outside the list).

Eager activation (S1.7): `enter()` is the waiter of every eager slot it owns (`startEagerSlots`); a timeout rejects activation with `ENTRY_ACTIVATION_FAILED` (`causeCode: 'INITIALIZATION_TIMEOUT'`, `causeDetails.slot` names the overdue slot), the existing rollback closes the new Env, and that close abandons the still-running attempt after the grace — so an eager late success is discarded *by the close*, a corollary of S1.6, and the docs say so. **Q4 —** the task book says the details "list the overdue slots" (plural). `startEagerSlots` rejects with the first failure; at that moment the other eager timers of the same tick have not fired (Node drains microtasks between timer callbacks), so a list would nearly always be the singleton `[causeDetails.slot]`. A real list requires waiting for every eager waiter to settle (`allSettled`), which changes *when* activation fails in every mixed case (one eager slot fails fast, another is slow). I recommend keeping the `ENTRY_ACTIVATION_FAILED` shape and timing and documenting that `causeDetails.slot` names the overdue slot; the alternative (`overdueSlots` via `allSettled`) is listed for the reviewer.

Garbage-collected raw Promise of an *overdue* attempt (owner alive): nothing can settle it, so the `FinalizationRegistry` path closes the attempt as failed (cleanups run, `attempt-unreachable`) and the sequence takes the ordinary failure path (the retry policy applies: a new attempt is sane because the old one can never complete). This is the "extra ledger shrink" role S2 keeps for the registry; no state assertion depends on it.

Unchanged and re-tested: `ROLLBACK_FAILED` finality for failed attempts, `foreign-thenable-setup`, the wait-cycle observation, `LOAD_CANCELLED`, `OWNER_NOT_READY`, the eager Ready rule, single-flight recovery (with a *failing* first attempt, since a running one is now joined — see Q6).

Cost: a `setTimeout` / `clearTimeout` pair per `load()` on a non-ready slot (today: one timer per attempt). The materialization benchmark cases load each slot once, so the per-attempt cost is unchanged; the gate's ±10 % same-session comparison against 0.6.0 (§11) shows whether the per-waiter bookkeeping is measurable. If it is, the mitigation is one timer per slot for the earliest pending waiter, not a relaxed tolerance.

### 2.3 Counter-example tests (A06)

All in a new `packages/core/tests/v07-s1-waiter-deadline.test.mjs`, none with `--expose-gc`:

1. Slow success adopted: `setup` resolves after 250 ms, `setupDeadlineMs: 100`; the first `load()` rejects with `INITIALIZATION_TIMEOUT` (`attemptStillRunning: true`), `attempt-overdue` once, `inspect()` shows `overdueMs`; a `load()` at 300 ms gets the instance; `onDispose` cleanup **not** run; slot `ready`; `late-setup-result` with `adopted: true`; `setup` called once; `runtime.inspect().unsettledAttempts` empty after adoption.
2. Same, owner disposed at 150 ms: the result is discarded, cleanup runs, `late-setup-result` with `adopted: false`, `attempt-abandoned` (the state and the fulfilled `dispose()` are S2's).
3. Two waiters time out one after the other (the second joins at 50 ms), then the attempt succeeds: both got `INITIALIZATION_TIMEOUT`, a third `load()` gets the instance, no waiter holds stale state (a further `load()` on the ready slot resolves immediately, ledger empty, `overdueMs` gone, exactly one `attempt-overdue`).
4. Eager: an eager slot that succeeds after the deadline; `enter()` rejects with `ENTRY_ACTIVATION_FAILED` / `causeCode INITIALIZATION_TIMEOUT`; the Env is closed; the late success is discarded and cleaned up (`adopted: false`); `liveEnvCount` back to 0.
5. A timeout consumes no attempt: `failure: { attempts: 2, delayMs: 200 }`, one slow success: `setup` called once, no backoff, adoption on attempt 1; control: a *failing* first attempt still retries with the backoff.
6. Default still 30_000: `v06-m1-limits.test.mjs` keeps its "defaults locked verbatim" case (source constant, d.ts doc, API_REFERENCE), reduced to the `limits` form.
7. Late failure of an overdue attempt: sticky → later loads reject with the setup's own error; `retry-on-next-load` → recovery after the cooldown; `late-setup-failure` reported.
8. `load({ signal: AbortSignal.timeout(20) })` on a slow slot: `LOAD_CANCELLED`, the attempt is unaffected and adopted later (the documented "shorter wait").

## 3. S2 — `env.state` and the ledger without GC

### 3.1 State

`activating → ready → disposing → disposed`, driven only by Runtime actions: `disposeEnv` sets `disposed` at the end of the bounded close (descendants closed, grace given, owned Ready slots disposed, `detachEnv`), whether or not attempts were abandoned. The `finalized` / `markFinalized` / pending-finalization machinery in `runtime.ts` (which made a parent's state wait for the late settlement of its descendants' attempts) is removed. `liveEnvCount` / `rootEnvCount` already drop the Env at that point (unchanged).

Abandoned attempts stay where they are recorded today — the ledger (`runtime.inspect().unsettledAttempts`, states `abandoned` / `rolling-back` / `settling`, plus `timed-out` per Q3) — and become visible per Env as `env.inspect().abandonedAttempts` (mandated by S2.2): the ledger entries whose slot this Env owns (`readonly UnsettledAttemptInspection[]`, same shape). A parent does not list its descendants' attempts; each Env lists its own (each Env disposes only the slots it owns, §13). Settlement (success or failure, both discarded because the owner is closed) removes the entry and emits the existing `late-setup-*` event; the slot goes `abandoned → disposed` as today.

`FinalizationRegistry`: kept only for the extra shrink and `attempt-unreachable` (S2.2). No test asserts a *state* through it: the two `--expose-gc` tests keep their ledger / cleanup / event assertions and drop their state assertions (§10).

### 3.2 `dispose()` contract — (i) vs (ii)

**(i) always fulfil; report through the ledger and events.** `env.dispose()` rejects only for real errors of the close itself (a cleanup that threw: the existing `AggregateError` of `DisposableError`s). Attempts that ignored the stop signal are not an error of the caller nor of the Runtime; they are reported by `attempt-abandoned` (one event per attempt, now carrying the `dependencies` list the `UNSETTLED_ATTEMPT` report used to carry, so nothing is lost — see below), by the ledger, and at `runtime.dispose()` by one summary event when the ledger is not empty (mandated by S2.3).

**(ii) fulfil by default, strict mode on request.** Same as (i) plus a way to make `dispose()` reject with `UNSETTLED_ATTEMPT` as in 0.6; the smallest form would be a `createRuntime` flag (a new public option name, which the task book allows only with approval) or a `dispose({ strict })` parameter (a new public parameter).

**Recommendation: (i).** Reasons:

1. Every `dispose()` caller in this repository already converts the 0.6 rejection into a report: `runtime.ts` `executeStructured` (which has to carry a *successful* business result on the rejection — `F-CL3-08`), Hyla-mini `disposeRecord` ("never rejects: a failed close is reported and counted") and `app.close()` (flattens the Runtime report into a returned record). The rejection is used as a report channel everywhere and never as control flow; (i) makes the report channel the primary one.
2. After S2.1 the 0.6 rejection's own message ("The Env stays disposing until they settle") is false: the Env is `disposed`.
3. Events carry strictly more than the one-shot rejection: per attempt, `attempt-abandoned` → `late-setup-result` / `late-setup-failure` / `attempt-unreachable`, plus the ledger in between.
4. (ii) doubles the documented behaviour of `dispose()` for the benefit of tests only, and needs a new public name on a 1.0-candidate surface.
5. Migration is mechanical: a caller that used the rejection reads `runtime.inspect().unsettledAttempts` / `env.inspect().abandonedAttempts` or subscribes to `attempt-abandoned`; the migration document gives the before/after snippet.

Under (i), mandated and proposed shapes:

- `attempt-abandoned` gains `dependencies: readonly { dependency, slot, revision, state }[]` (the acknowledged "closed in the normal order regardless" list from the 0.6 `UNSETTLED_ATTEMPT` env report; `phase` stays).
- **Q5 — the summary event's name and shape.** Proposed: `{ type: 'attempts-outstanding', attempts: readonly UnsettledAttemptInspection[] }`, emitted once at the end of `runtime.dispose()` when the ledger is not empty (after the existing ≤ grace wait for `settling` cleanups, which stays).
- `runtime.dispose()` rejects only for cleanup errors (the `AggregateError` without an `UNSETTLED_ATTEMPT` member); a second call returns the same Promise (unchanged).
- `run()` fulfils with the callback's result when the only thing wrong with the close is an abandoned attempt; the non-enumerable `result` on a close *error* stays for cleanup failures (`F-CL3-08` is rewritten around a throwing cleanup).
- `UNSETTLED_ATTEMPT` details tighten to the recovery shape `{ slot, revision, attempt, runningForMs }` (mandated under (i) by S2.4).
- **Q6 — `UNSETTLED_ATTEMPT` has no throw site left.** The task book keeps the code for "recovery requested while an attempt is unsettled". That path (`assertNoUnsettledAttempt`, reached from `recoverFailedSlot` and `startSequence`) exists in 0.6 only because a timeout made the slot `failed` while its attempt kept running. Under S1 a slot with a running attempt is `starting`, a `load()` joins it, and a slot is `failed` only after its last attempt settled and rolled back; under (i) the dispose path does not throw it either. So after S1 + S2(i) the code is unreachable. Options: (a) keep it in `SynaErrorCode` with the tightened details and no throw site (the task book's wording; but a code without a throw site is exactly what §2.2/§2.3 remove elsewhere, and A04-style "every throw point has a test" cannot hold for it); (b) delete it from the union (a public name removal outside §2.1, needs approval). I recommend (b) with a migration row and a `no-old-names` pattern; (a) is what I implement if the reviewer prefers the literal text.

### 3.3 Counter-example tests (A07)

New `packages/core/tests/v07-s2-state-and-ledger.test.mjs`, no `--expose-gc`:

1. `setup: () => new Promise(() => {})`, `disposalGraceMs: 20`: `dispose()` fulfils after the grace; `env.state === 'disposed'`; `liveEnvCount` decreased by one; ledger has one `abandoned` entry naming the Env; `env.inspect().abandonedAttempts.length === 1`; `attempt-abandoned` with `dependencies`.
2. The raw Promise is kept referenced (a variable holds it) / released: `state` is `'disposed'` in both cases, before and after several macrotasks; the ledger entry stays until settlement.
3. Late settlement (a gate resolves the setup): entry removed, `late-setup-result` with `adopted: false`, cleanup ran, slot `disposed`, `abandonedAttempts` empty.
4. Parent/child: a child with an abandoned attempt; the parent's `dispose()` fulfils and both are `disposed`; the child's `abandonedAttempts` lists it, the parent's is empty.
5. `runtime.dispose()` with a non-empty ledger fulfils and emits `attempts-outstanding` once with the entries; a throwing cleanup still rejects (`AggregateError` without an `UNSETTLED_ATTEMPT` member).
6. Rolling back past the grace (`F-CL3-05a` rewritten): state `disposed`, ledger `rolling-back` → empty.
7. GC (kept, `--expose-gc`, ledger-only): `F-CL3-03` and `R-3 retention` without their state assertions.

## 4. S6 — `FRESH_CONSTRAINT_FAILED` split (the task-book table, verbatim)

| Throw site | 0.7 code | `details` | Message (unchanged) |
|---|---|---|---|
| `entry-planner.ts:829` `validateScopeTargets`, revision target inactive | `INACTIVE_REUSE_TARGET` | `{ constraint: 'fresh' \| 'share', env, revision }` | `${kind} targets inactive Service Revision ${key}.` |
| `entry-planner.ts:838` same, family target | `INACTIVE_REUSE_TARGET` | `{ constraint, env, family }` | `${kind} targets inactive Service Family ${family}.` |
| `graph-builder.ts:321` inherited resolution no longer valid | `INVALID_INHERITED_CHOICE` | `{ site, selectedKey, candidates }` | `The inherited resolution ${selectedKey} is no longer valid at ${site}.` |
| `implementation-directory.ts:247` CandidateRef of another collection | `FOREIGN_CANDIDATE_REF` | `{ expectedSourceSlot, receivedSourceSlot }` | `CandidateRef belongs to another implementation collection.` |

`FRESH_CONSTRAINT_FAILED` leaves `SynaErrorCode`; `SHARE_CONSTRAINT_FAILED` untouched. `internal/solve-errors.ts` (the backtrackable set, which decides whether `check()`/`explain()` report or throw and whether the planner backtracks) lists `INACTIVE_REUSE_TARGET` and `INVALID_INHERITED_CHOICE` in place of the old code, so planning behaviour is unchanged by construction; `FOREIGN_CANDIDATE_REF` is thrown by `ImplementationSet.resolve()`/`load()` at run time, outside the planner, and is not backtrackable (it never was reachable from a solve). Snapshot: the recorded `checkChildFreshInactive` / `deriveFreshInactive` entries carry `CONSTRAINT_VIOLATION` (0.5) mapped to `FRESH_CONSTRAINT_FAILED` by `RENAMED`; the mapping gains the 0.7 value and the added `constraint: 'fresh'` key (§9). Tests: `contracts.test.mjs:139`, `v05-planner.test.mjs` R14/K03, `v06-t1-errors` update their codes; one table-driven test asserts the four sites with codes and full details (A03). The `ReuseConstraints` doc comment (`descriptors.ts:422`) and the API_REFERENCE mentions name the new code.

## 5. S7 — `INVALID_ENV_STATE` and `INVALID_DESCRIPTOR`

### 5.1 `INVALID_ENV_STATE`: every throw site → code

The task book counts 12 sites; DEFERRED S7 said 16. Counting *message sites* — the 11 literal `new SynaError('INVALID_ENV_STATE', …)` plus the five paths through `internal/abort.ts` (`abortError` / `assertNotAborted` / `sleepAbortable`) — gives 16, listed in full with their 0.6 messages:

| # | Site | Message (0.6, unchanged) | 0.6 details | 0.7 code | 0.7 details |
|---|---|---|---|---|---|
| 1 | `runtime.ts:599` activation finished after the Env was closed | `Env ${id} was closed before activation completed.` | `{ env, state }` | `ENV_CLOSED` | `{ env, state }` |
| 2 | `runtime.ts:637` `requireEnv` (anchored entry whose anchor is gone) | `Env ${id} is no longer live.` | `{ env }` | `ENV_CLOSED` | `{ env, state: 'disposed' }` (a detached Env is `disposed` under S2) |
| 3 | `runtime.ts:666` any entry point on a disposed Runtime | `The Syna Runtime is disposed.` | `{}` | `RUNTIME_CLOSED` | `{}` (`Record<string, never>`, as `RUNTIME_MISMATCH`) |
| 4 | `runtime.ts:684` enter/derive/check/explain from a disposing or disposed Env | `Cannot enter from Env ${id} while it is ${state}.` | `{ entry, env, state }` | `ENV_CLOSED` | `{ env, state }` (the entry id stays in the message) |
| 5 | `runtime.ts:708` anchor node missing from the plan | `Missing anchor node ${id}.` | `{ node }` | internal invariant (Q7) | — |
| 6 | `materializer.ts:339` `load()` on a disposing / disposed / abandoned slot | `Service slot ${slot} (${key}) is ${state}.` | `{ slot, revision, state }` | `SLOT_NOT_LOADABLE` | `{ slot, revision, state }` (slot state) |
| 7 | `materializer.ts:359` slot without owner Env | `Service slot ${slot} has no owner Env.` | `{ slot }` | internal invariant (Q7) | — |
| 8 | `materializer.ts:445` sequence loop ran zero attempts | `Service ${key} exhausted setup attempts.` | `{}` | internal invariant (Q7; `failure.attempts ≥ 1` is enforced at definition time) | — |
| 9 | `materializer.ts:481` `onDispose()` after the attempt settled | `onDispose() for ${key} may only be called while its setup attempt is still executing.` | `{ slot, revision, attempt, state }` | `LIFECYCLE_MISUSE` | `{ slot, revision, attempt, state }` (attempt state) |
| 10 | `materializer.ts:789` recovery finds the slot in an unexpected state | `Cannot recover ${key} from state ${state}.` | `{ slot, revision, state }` | internal invariant (Q7; the owner was just checked usable and recovery is single-flight, so the state is `failed`) | — |
| 11 | `materializer.ts:517` attempt abandoned by the owner's close | `Setup of ${key} was still pending when owner Env ${env} closed; its eventual result will be discarded.` | `{ slot, revision, env, attempt }` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 12 | `materializer.ts:544` setup completed after the owner began closing | `Setup of ${key} completed after owner Env ${env} began closing; the instance was discarded.` | `{ slot, revision, env }` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 13 | `materializer.ts:816` `assertOwnerUsable`, owner disposing/disposed | `Cannot ${action} ${key} while owner Env ${env} is ${state}.` | `{ slot, revision, env, state }` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 14 | `materializer.ts:811` → `abort.ts:8` `assertOwnerUsable`, owner signal aborted | `Cannot ${action} ${key}: owner Env ${env} is closing.` | `{}` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 15 | `materializer.ts:439` → `sleepAbortable`, retry backoff cancelled | `Retry of ${key} was cancelled because owner Env ${env} is closing.` | `{}` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 16 | `materializer.ts:777` → `sleepAbortable`, recovery cooldown cancelled | `Recovery of ${key} was cancelled because owner Env ${env} is closing.` | `{}` | `ENV_CLOSED` | `{ env, state, slot, revision }` |

Four codes, each with ≤ 2 detail shapes: `ENV_CLOSED` (`{ env, state }` | `{ env, state, slot, revision }`), `RUNTIME_CLOSED` (`{}`), `SLOT_NOT_LOADABLE` (`{ slot, revision, state }`), `LIFECYCLE_MISUSE` (`{ slot, revision, attempt, state }`). `INVALID_ENV_STATE` leaves the union. Messages unchanged.

Differences from the task-book suggestion, with reasons: `ENV_NOT_READY` is not needed — the "not ready" state `activating` is already `OWNER_NOT_READY` (kept), and every remaining non-ready state is a closed one, so it would duplicate `ENV_CLOSED`. Its slot goes to `RUNTIME_CLOSED`, because "the Runtime is disposed" (site 3) has no Env to name and folding it into `ENV_CLOSED` would need a nullable `env` (an `undefined`/`null` required field is what A05 forbids). `LIFECYCLE_MISUSE` is kept as its own code rather than folded into `INVALID_DESCRIPTOR`: an `onDispose()` call at the wrong time is not a descriptor problem, and the `{ descriptor, problem }` shape of §5.2 would not describe it. The `abort.ts` helpers take a details factory so sites 14–16 carry the owner and slot.

**Q7 — the unreachable sites 5, 7, 8, 10.** They are internal invariants (plan consistency, owner assignment done in `enterFrom` before any ref exists, `attempts ≥ 1`, single-flight recovery on a usable owner), not states a caller can produce, so no test can cover them under any code. I propose to make them plain `Error('Syna internal invariant: …')` throws (not `SynaError`, no public code), so that A04 ("each throw point of the split has a test") is true of every public code. Alternative: keep them as `SLOT_NOT_LOADABLE` / `ENV_CLOSED` throws and document them as untestable.

### 5.2 `INVALID_DESCRIPTOR`: the 28 sites in the one shape `{ descriptor, problem, site?, path? }`

`descriptor` names what was expected or which descriptor is wrong (a kind name, or the id / key when it is known); `problem` is a stable token from a closed vocabulary (`not-an-object`, `not-an-array`, `wrong-kind`, `unknown-kind`, `empty-contract-id`, `self-override`, `override-cycle`, `forward-cycle`, `not-service-revisions`, `parameters-not-an-object`, `invalid-assignment`, `not-from-this-runtime`, `policy-result-not-an-array`, `policy-result-not-a-permutation`); `site` where a dependency site exists; `path` where a chain exists. Messages are unchanged. A table-driven test builds every case through the public API and asserts code, `details` (never `{}`) and the documented shape.

| # | Site | Message (0.6, unchanged) | 0.7 `details` |
|---|---|---|---|
| 1 | `definition-compiler.ts:70` | `createRuntime() requires a services array.` | `{ descriptor: 'CreateRuntimeOptions.services', problem: 'not-an-array' }` |
| 2 | `definition-compiler.ts:195` | `Expected a Contract descriptor.` | `{ descriptor: 'Contract', problem: 'wrong-kind' }` |
| 3 | `definition-compiler.ts:221` | `Expected an Entry descriptor.` | `{ descriptor: 'Entry', problem: 'wrong-kind' }` |
| 4 | `definition-compiler.ts:262` | `createRuntime() overrides must be an array.` | `{ descriptor: 'CreateRuntimeOptions.overrides', problem: 'not-an-array' }` |
| 5 | `definition-compiler.ts:268` | `Invalid Runtime service override descriptor.` | `{ descriptor: 'ServiceOverride', problem: 'wrong-kind' }` |
| 6 | `definition-compiler.ts:271` | `override() expects two ServiceRevision descriptors.` | `{ descriptor: 'ServiceOverride', problem: 'not-service-revisions' }` |
| 7 | `definition-compiler.ts:275` | `Service ${key} cannot override itself.` | `{ descriptor: key, problem: 'self-override' }` |
| 8 | `definition-compiler.ts:311` | `Runtime service overrides contain a cycle at ${key}.` | `{ descriptor: key, problem: 'override-cycle', path: [chain of keys] }` (the 0.6 key `revision` becomes `descriptor`) |
| 9 | `definition-compiler.ts:329` | `Runtime services must be ServiceRevision descriptors.` | `{ descriptor: 'ServiceRevision', problem: 'wrong-kind' }` |
| 10 | `definition-compiler.ts:343` | `A Service dependency must be a ServiceRevision descriptor.` | `{ descriptor: 'ServiceRevision', problem: 'wrong-kind' }` |
| 11 | `definition-compiler.ts:373` | `Unknown dependency descriptor kind ${kind}.` | `{ descriptor: 'Dependency', problem: 'unknown-kind' }` |
| 12 | `definition-compiler.ts:416` | `${key} provides a Contract with an empty id.` | `{ descriptor: key, problem: 'empty-contract-id' }` |
| 13 | `entry-planner.ts:95` | `Reuse targets must be Service revisions or families.` | `{ descriptor: 'ReuseTarget', problem: 'not-an-object' }` |
| 14 | `entry-planner.ts:197` | `Entry ${id} parameters must be an object.` | `{ descriptor: id, problem: 'parameters-not-an-object' }` |
| 15 | `entry-planner.ts:953` | `Invalid assignment for Binding ${id}.` | `{ descriptor: id, problem: 'invalid-assignment' }` (the 0.6 key `binding` becomes `descriptor`) |
| 16 | `graph-builder.ts:304` | `Unknown dependency descriptor at ${site}.` | `{ descriptor: 'Dependency', problem: 'unknown-kind', site }` |
| 17 | `identity.ts:29` | `A dependency must be a descriptor object.` | `{ descriptor: 'Dependency', problem: 'not-an-object' }` |
| 18 | `identity.ts:34` | `A forward dependency descriptor resolves to itself.` | `{ descriptor: 'ForwardDependency', problem: 'forward-cycle' }` |
| 19 | `identity.ts:41` | `A forward dependency resolved to a non-descriptor value.` | `{ descriptor: 'ForwardDependency', problem: 'not-an-object' }` |
| 20 | `identity.ts:68` | `Unknown dependency descriptor kind ${kind}.` | `{ descriptor: 'Dependency', problem: 'unknown-kind' }` |
| 21 | `implementation-directory.ts:62` | `catalog.implementations() expects a Contract descriptor.` | `{ descriptor: 'Contract', problem: 'wrong-kind' }` |
| 22 | `implementation-directory.ts:75` | `catalog.resolve() expects a persistent implementation reference.` | `{ descriptor: 'ImplementationRef', problem: 'wrong-kind' }` |
| 23 | `implementation-directory.ts:174` | `Resolution policy must return an array of candidates at ${site}.` | `{ descriptor: 'RuntimePolicy', problem: 'policy-result-not-an-array', site }` |
| 24 | `implementation-directory.ts:186` | `Resolution policy must return every candidate exactly once at ${site}.` | `{ descriptor: 'RuntimePolicy', problem: 'policy-result-not-a-permutation', site }` (the 0.6 keys `original` / `ordered` are dropped: the shape has no place for them; recorded in the migration table) |
| 25 | `implementation-directory.ts:219` | `resolve() expects a persistent implementation reference.` | `{ descriptor: 'ImplementationRef', problem: 'wrong-kind' }` |
| 26 | `implementation-directory.ts:235` | `Expected a candidate, candidate ref or persistent ref.` | `{ descriptor: 'ImplementationCandidate', problem: 'not-an-object' }` |
| 27 | `implementation-directory.ts:243` | `Expected a CandidateRef created by this Runtime.` | `{ descriptor: 'CandidateRef', problem: 'not-from-this-runtime' }` |
| 28 | `runtime.ts:668` | `Expected an Entry descriptor.` | `{ descriptor: 'Entry', problem: 'wrong-kind' }` |

Sites 11/20 and 3/28 are duplicates by message (compiler vs identity, compiler vs Runtime entry); each keeps its own row and its own test case. Sites 8, 15, 23, 24 are the four that carry details today (`revision`, `binding`, `site`, `site + original + ordered`); the other 24 carry `{}` in 0.6, which is what A05 forbids.

## 6. S8 — `MISSING_IMPLEMENTATION`: six sites, three shapes, no optional field

| # | Site | Message (unchanged) | 0.6 details | 0.7 details |
|---|---|---|---|---|
| 1 | `entry-planner.ts:969` Binding assignment | `No admitted ${family} revision satisfies ${version} and ${contract}.` | `{ binding, implementation, version, available }` | shape A `{ binding, implementation, version, available }` |
| 2 | `graph-builder.ts:234` bare Contract without implementer | `No admitted Service implements Contract ${id}.` | `{ contract, site }` | shape B `{ contract, site }` |
| 3 | `graph-builder.ts:264` `auto()` without implementer | same | `{ contract, site }` | shape B |
| 4 | `implementation-directory.ts:127` family not admitted | `Implementation family ${family} is not admitted by this Runtime; no supplier substitution is attempted.` | `{ contract, implementation, version }` | shape C `{ contract, implementation, version, available: [] }` |
| 5 | `implementation-directory.ts:138` no candidate satisfies the range | `No ${family} candidate for ${contract} satisfies ${version}.` | `{ contract, implementation, version, available }` | shape C |
| 6 | `implementation-directory.ts:258` CandidateRef of this collection names an unknown revision | `Candidate does not belong to this implementation collection.` | `{ revision: string \| undefined }` | shape C: `contract` = the collection's Contract; `implementation` / `version` parsed from the ref's `revisionKey` (`family@version`); `available` = the versions this collection holds for that family (`[]` if none) |

**Q8 —** site 6 today reads `ref.revisionKey` as-is; a ref whose `revisionKey` is not a string is a malformed object, not a missing implementation. I propose that the `CandidateRef` validation at site 27 of §5.2 (`Expected a CandidateRef created by this Runtime.`) also requires a string `revisionKey`, so site 6 always has a real key to parse and `details.revision` (now `implementation` / `version`) can never be `undefined`. The reachable case for site 6 is a CandidateRef from *another Runtime* whose slot ids coincide (slot ids are per-Runtime counters). This moves one malformed-input case from `MISSING_IMPLEMENTATION` to `INVALID_DESCRIPTOR`; §2.3 says "codes and details only", so it is listed for approval. The alternative is `String(ref.revisionKey)` (never `undefined`, but `'undefined'`).

## 7. S10 — `asSynaError()`

Runtime contract: a `SynaError` passes through; anything else is wrapped with `cause` = the original value (Error or not; today only `Error` instances become `cause`) and `details.cause = { name, message }` (`name`: `error.name` for an `Error`, else `typeof error`; `message`: `error.message` for an `Error`, else `String(error)`). Nothing is read from the foreign object beyond those two strings. `asSynaError` has no caller in the repository today; a unit test covers Error / non-Error / SynaError inputs.

**Q9 — typing.** The literal wording ("details fixed to `{ cause: { name, message } }`") cannot be typed honestly against T1: `SynaError<'MISSING_INPUT'>` promises `details.input`, and a wrapped error with that code and only `cause` would violate it (or force every code's details union to admit the wrapped shape, which destroys narrowing for the normal case). I propose the superset: `asSynaError(error, code, message, ...details as typed by T1)` produces `details = { ...siteDetails, cause: { name, message } }` and its return type is `SynaErrorOf<Code> & { readonly details: { readonly cause: { readonly name: string; readonly message: string } } }` — assignable to `SynaError<Code>`, structurally honest, and `cause` is always present and fixed. The literal alternative (drop the details parameter, return the code with `{ cause }` only) is implementable only with a type-level lie and is listed for the reviewer.

## 8. `implementationId` as a persisted key (A11)

`Binding.parse()` / `parseImplementationRef()` keep accepting `implementationId` permanently (the 0.6 R5 rule stays: both keys must agree when both are present; neither → `TypeError`), and `kind === 'persistent-implementation-ref'` stays as the on-disk discriminator (documented as "name from 0.4, format stable"). The runtime getter `ref.implementationId` is deleted (§2.1). Docs and the `syna-v05-compat` markers that say "until 0.7.0" are reworded to "permanent (data compatibility)".

The mandated diagnostics event has no Runtime at `parse()` time (a Binding descriptor has no `onEvent`). Proposed mechanics: `parse()` normalises to `{ kind, contractId, familyId, version }` and, when the input carried the old key, marks the produced ref with a **Symbol-keyed, non-enumerable, non-serialised** property (no public name, invisible to JSON and to the type); every Runtime path that reads a ref — `catalog.resolve`, `ImplementationSet.resolve` / `load`, and the Binding assignment in `entry-planner.ts:962` (`familyIdOf(assignment)`, routed through the directory so the planner gains no event hook of its own) — emits the event when it meets either the marker or a raw object carrying the old key. **Q10 — name and shape:** `{ type: 'legacy-implementation-ref', contractId, familyId, version, site }`, once per read. Hyla-mini's `normalizeStoredImplementationRef` (its own read boundary for stored recipes and site configuration) keeps working; its `syna-v05-compat` marker stays because the key is permanent data compatibility, and the test for A11 spells the key under the same marker.

Emitting during a planning read does not change plans, explanations or the cache; diagnostics are fire-and-forget.

## 9. Reference planner differential and explain/inspect snapshots (§3 A.3)

- S1 and S2 touch `materializer.ts`, `runtime.ts` (`EnvImpl`, `disposeEnv`, `RuntimeImpl.dispose`), `abort.ts`, `runtime-model.ts`, `descriptors.ts` (events, inspection fields, details) and `errors.ts`. No planner, graph-builder, compiler, directory or cache code path changes for them. `reference-planner.test.mjs` exercises `check`/`explain`/`enter` plans only → verbatim.
- The snapshot (`packages/core/tests/snapshots/v05-explain-inspect.json`) records `runtime.inspect()` (`unsettledAttempts: []` in the fixed world — unchanged by S1/S2, the world has no stuck setup), `env.inspect()` for root and child, check/explain/catalog results and ten error captures. Impact, by cause:
  - **S2** adds `abandonedAttempts` (`[]` in the fixed world) to `env.inspect()` → the recorded `rootInspect` / `childInspect` objects lack the key. The recorded file stays byte-identical; `v06-snapshots.test.mjs` gets, next to `RENAMED`, an explicit `ADDED` table applied to the recording (`EnvInspection.abandonedAttempts: []`) so every 0.7 addition to an inspection is named in one place. `overdueMs` is absent when not overdue → no impact.
  - **S6** changes the recorded `checkChildFreshInactive` and `errors.deriveFreshInactive` (`CONSTRAINT_VIOLATION` → `INACTIVE_REUSE_TARGET`, details gain `constraint: 'fresh'`) → one `RENAMED.values` entry and one `ADDED` entry.
  - S7/S8/S10: the snapshot holds no `INVALID_DESCRIPTOR` / `INVALID_ENV_STATE` capture; its two `MISSING_IMPLEMENTATION` captures are sites 1 and 5, whose shapes are unchanged → no impact.
  - S1: no impact (no timeout in the fixed world).

  So the planner differential and the snapshot data stay verbatim; the comparison acknowledges exactly the S6 code split and the S2 inspection field, both mandated by the task book, and nothing else. Nothing was "missed".

## 10. Existing tests that assert the old S1/S2 semantics (withdrawal register)

Every row names the old semantic the assertion pins. "Rewrite" means the test keeps its scenario and asserts the 0.7 behaviour instead; "code" means only an error code changes (S6/S7). Each withdrawn assertion will be registered in `docs/SEMANTIC_CHANGES_V07.md` §撤回 with this table's wording.

| File · test | Assertion(s) | Old semantic | Disposition |
|---|---|---|---|
| `v05-attempts` · R09 recovery refused while an old attempt runs | 2nd `load()` → `UNSETTLED_ATTEMPT`; late value discarded (`late-cleanup`, `late-setup-result`); `attempts === 2` afterwards | timeout fails the slot; late success discarded; recovery blocked | Rewrite: 2nd `load()` joins; success adopted (`attempts: 1`, no cleanup, `adopted: true`); single-flight recovery kept with a *failing* first attempt |
| `v05-attempts` · K08 disposal reports … `UNSETTLED_ATTEMPT` … | `dispose()` rejects with `UNSETTLED_ATTEMPT`; `env.state === 'disposing'` | dispose rejects; state waits for GC/settlement | Rewrite: fulfils; `disposed`; ledger + `attempt-abandoned` + slot `abandoned` kept |
| `v05-attempts` · K08 completes after the owner started closing | `error.code === 'INVALID_ENV_STATE'` | — | code → `ENV_CLOSED` |
| `v05-audit-lifecycle` · F-PL-01 bounded by grace | `disposal.ok === false` with `UNSETTLED_ATTEMPT` | dispose rejects | Rewrite: fulfils within the bound; ledger asserted |
| `v05-audit-lifecycle` · F-PL-01 Infinity | `disposal.ok === false`; `running.ok === false` ("run() reports the abandoned attempt") | dispose/run reject | Rewrite: both fulfil, bounded; the attempt is in the ledger/event |
| `v05-audit-lifecycle` · F-PL-02 onDispose after the deadline honoured by late-settlement cleanup | resource closed right after the late result; `late-setup-result` | late success discarded | Rewrite: adopted (`adopted: true`), cleanup runs at `env.dispose()` |
| `v05-audit-lifecycle` · F-PL-02 onDispose after the owner closed | `dispose()` rejects | dispose rejects | Rewrite: fulfils; cleanup still runs at settlement |
| `v05-audit-lifecycle` · F-PL-02 stale lifecycle | `INVALID_ENV_STATE` | — | code → `LIFECYCLE_MISUSE` |
| `v05-audit-lifecycle` · F-PL-03 broadcast | three `INVALID_ENV_STATE` | — | code → `ENV_CLOSED` / `SLOT_NOT_LOADABLE` as each site yields (asserted precisely) |
| `v05-audit-lifecycle` · F-PL-04 honest state | `dispose()` rejects; `state 'disposing'`; `runtime.dispose()` rejects; `'disposed'` only after settlement | state follows settlement; dispose rejects | Rewrite: `disposed` at once; fulfils; ledger/events/`attempts-outstanding` asserted |
| `v05-audit-lifecycle` · F-PL-04 parent honest | `['disposing','disposing']` then `['disposed','disposed']`; `root.dispose()` rejects | parent state follows child's attempts | Rewrite: both `disposed`; fulfils; child's `abandonedAttempts` |
| `v05-review-lifecycle` · R-1 late cleanup fails after `INITIALIZATION_TIMEOUT` → final | ledger `['timed-out','timed-out']`; late results discarded with cleanup; `ROLLBACK_FAILED` after a failed late cleanup | late success discarded + cleaned at settlement | Rewrite: ledger `timed-out` while overdue (Q3), both adopted, cleanups run at `dispose()`, a throwing cleanup is a dispose error; the `ROLLBACK_FAILED`-by-late-cleanup case is withdrawn (it cannot occur: nothing is cleaned at adoption); rollback finality itself stays covered by the sibling R-1 test |
| `v05-review-lifecycle` · R-1/R-4 cancellation paths | expected `'INVALID_ENV_STATE'` entries | — | code → `ENV_CLOSED` |
| `v05-review-lifecycle` · R-3 bounded close | `children.every(state === 'disposing')` (×2); `runtime.dispose()` rejects with 20 attempts | state/rejection | Rewrite: `disposed`; `attempts-outstanding` with 20 entries; ledger/events kept |
| `v05-review-lifecycle` · R-3 retention (`--expose-gc`) | `before.keptState === 'disposing'`; `keptState === 'disposed'` after GC | state follows GC | Withdraw the two state assertions; keep collected/cleanups/`attempt-unreachable`/ledger (ledger-only GC test) |
| `v05-review-lifecycle` · R-4 abandoned deps | `UNSETTLED_ATTEMPT` report `details.slots[0].dependencies` | dispose rejects | Rewrite: the same `dependencies` list on `attempt-abandoned`; fulfils; the rest kept |
| `v05-review-lifecycle` · R-5 deadline inside the grace | `load` → `INITIALIZATION_TIMEOUT` (kept); `≥ 300 ms` remainder; rejects; `'disposing'`; control likewise | the deadline settled the sequence inside the grace | Rewrite: the waiter times out, the attempt gets the whole grace, abandoned + reported, `disposed`; control likewise |
| `v05-audit3` · F-CL3-03 unreachable (`--expose-gc`) | `keptState === 'disposed'` | state follows GC | Withdraw that assertion; ledger/cleanup/event kept |
| `v05-audit3` · F-CL3-05a rolling back | rejects; `'disposing'`; `runtime.dispose()` rejects | dispose rejects; state | Rewrite: fulfils, `disposed`, ledger `rolling-back` → empty, slot `disposed` |
| `v05-audit3` · F-CL3-05b settling | rejects (×3); `'disposing'` (×2) | same | Rewrite: fulfils; ledger `abandoned` → `settling` → empty; the summary event once |
| `v05-audit3` · F-CL3-05c settling grace | `INITIALIZATION_TIMEOUT` (kept); rejects; `'disposing'` | same | Rewrite: fulfils; `runtime.dispose()` still waits within the grace |
| `v05-audit3` · F-CL3-08 run() result on the close error | close error from a stuck setup carries `result` | run rejects for an abandoned attempt | Rewrite with a throwing cleanup (the `result`-on-error mechanism is unchanged); a stuck setup now yields the result directly (asserted) |
| `v06-m1-limits` · "each old nested record maps…" | `dispose()` rejects with `UNSETTLED_ATTEMPT` | dispose rejects | Deleted with the alias half; the defaults/validation cases keep only the `limits` form |
| `core` · disposed Env cannot materialize; `v05-cache-cleanup` K09; `v05-definitions` K01 (`enter` after `runtime.dispose()`); `v06-r2` (deleted); Hyla-mini `site-manager` F-AP3-04 `cause.code` | `INVALID_ENV_STATE` | — | code → `ENV_CLOSED` / `SLOT_NOT_LOADABLE` / `RUNTIME_CLOSED` as the site yields |
| `contracts` C.all CandidateRefs; `v05-planner` R14, K03 | `FRESH_CONSTRAINT_FAILED` | — | code → `FOREIGN_CANDIDATE_REF` / `INACTIVE_REUSE_TARGET` |
| `hardening`, `lifecycle`, `v05-promises` R04, `features-demo` wait cycles | `INITIALIZATION_TIMEOUT` + cycle observation | — | Kept unchanged (the waiter's timeout and the observation are the same); the slots end `failed` because the setups' own inner waits time out |
| `hyla-mini/tests/review-app` · R-2/R-3 close() returns attempts | `reported[0].errors` has `UNSETTLED_ATTEMPT`; `report.errors.some(UNSETTLED_ATTEMPT)` | Env/Runtime dispose reject | Rewrite: `onDisposalError` not called for an abandoned attempt; `report.unsettledAttempts` (ledger) asserted; `attempts-outstanding` observed through the app's diagnostics |
| `hyla-mini/src/site/inputs.ts`, `docs/HYLA_MINI.md` | `onDisposalError` doc mentions `UNSETTLED_ATTEMPT` | — | Doc update |
| `v06-r1`…`v06-r6` alias-equivalence tests, `v06-compat` markers | exercise the expired forms | — | Deleted with the aliases; their 0.6-form assertions not covered elsewhere (call-shape TypeErrors, anchored call shapes, `parse()` of the old key) move to `v07-*.test.mjs` without the old forms |
| `v06-snapshots` | `RENAMED` mapping | — | + `ADDED` table (§9) |
| `v06-t1-errors` | 22 codes; per-code detail keys | — | 0.7 code list and shapes |
| `scripts/tests/api-inventory`, `deprecations`, `no-old-names` | 23 deprecated, 22 codes; alias list; pattern table | — | 0 deprecated; new code count; `EXPECTED = []`; patterns for the 23 names, `FRESH_CONSTRAINT_FAILED`, `INVALID_ENV_STATE`, `UNSETTLED_ATTEMPT` (if Q6b), `availability`, `CandidateAvailability`, `AvailableImplementationCandidate` |

No test that asserts an invariant conflicts with S1 or S2: bounded close, dependant-first disposal, `ROLLBACK_FAILED` finality, single attempt per slot, `LOAD_CANCELLED`, the eager Ready rule and the wait-cycle observation all keep passing with the same assertions. Nothing in this register is a "stop and report" case under §1 of the task book.

## 11. Phases, commits, gate

- **B** (2 commits): §2.1 deletions with `no-old-names` patterns, app/demo/benchmark/script migration (grep shows no application spells an expired form; the core tests and type tests do), `deprecations` test → `EXPECTED = []`; §2.2 remnants.
- **C** (4 commits): S6; S7 (`INVALID_ENV_STATE` split + `INVALID_DESCRIPTOR` normalisation, two table-driven tests); S8; S10. `SynaErrorDetails`, the `dist` d.ts and the API_REFERENCE error table follow each commit (`v06-t1-errors` keeps them in step).
- **D** (1 commit): S1 in the materializer, `v07-s1-waiter-deadline.test.mjs`, rewrites of §10, SEMANTIC_MODEL §11.
- **E** (1 commit): S2 in `runtime.ts` / `materializer.ts`, `v07-s2-state-and-ledger.test.mjs`, rewrites of §10, SEMANTIC_MODEL §13, Hyla-mini report path.
- **F** (1 commit): `SEMANTIC_CHANGES_V07.md` (保留 / 澄清 S7 S8 S10 / 修订 S1 S2 S6 / 撤回 = §10 / 到期删除 §2.1–2.2), `MIGRATION_V06_TO_V07.md` (deletions with replacements; error-code map `FRESH_CONSTRAINT_FAILED` → 3 codes, `INVALID_ENV_STATE` → 4 codes, `UNSETTLED_ATTEMPT` per Q6, `INVALID_DESCRIPTOR` / `MISSING_IMPLEMENTATION` detail-key changes; S1/S2 behaviour differences with the user-code patterns to check: `catch` on `dispose()`, `isSynaError(e, 'INITIALIZATION_TIMEOUT')` no longer meaning a dead attempt, `env.state === 'disposing'` polling, `details.original/ordered`), `API_STABILITY.md` 1.0-candidate section, `DEFERRED.md` (drop N2, S1, S2, S6, S7, S8, S10; keep N1, N3–N7, S3, S4, S5, S9 with updated "why still deferred"), `CHANGELOG.md` 0.7.0, API_REFERENCE, ARCHITECTURE, READMEs' error mentions, version 0.7.0 everywhere (`package-lock.json` included).
- **G**: `scripts/verify-v07.mjs` = the v0.6 gate with `validation/v0.7-release`, `syna-v0.7.0-source`, the same-session benchmark against 0.6.0 (commit 582c93a, the last 0.6 source; ±10 %, counters equal), inventory diff against `work/v07/API_INVENTORY_BEFORE.json` with a gate assertion of **0 `@deprecated` items**, `any` against a recorded 0.6.0 baseline (`scripts/any-baseline-v0.6.0.json`: the current count is 183 against the 0.5.0 file's 204, so "any 不增" is measured from 0.6, not 0.5), consumer smoke on the 0.7 names; then the two-run protocol (run → VALIDATION.md → run on that source → evidence), `work/v07/STATE.md`, and the final report with the gate summary, archive hashes, inventory diff statistics and the withdrawal list of §10.

## 12. Questions for the review (recommendation first)

| Q | Question | Recommendation |
|---|---|---|
| Q1 | A `scope` key in the call-time parameter record after the deletion | `TypeError` naming `{ reuse }`; `scope` stays a reserved parameter id |
| Q2 | Delete `AvailableImplementationCandidate` with `availability` | Yes (it is defined by the deleted field; unused) |
| Q3 | Overdue attempts in `inspect().unsettledAttempts` as `timed-out` | Yes (keeps the union and the ledger's meaning; R-1's ledger assertion survives) |
| Q4 | "details list the overdue slots" on `ENTRY_ACTIVATION_FAILED` | Keep the shape; `causeDetails.slot` names it (no `allSettled`) |
| Q5 | Summary event at the end of `runtime.dispose()` | `{ type: 'attempts-outstanding', attempts }` |
| Q6 | `UNSETTLED_ATTEMPT` after S1 + S2(i) has no throw site | Delete it from `SynaErrorCode` (migration row); keep-with-no-site if the literal text is preferred |
| Q7 | Unreachable `INVALID_ENV_STATE` sites 5, 7, 8, 10 | Plain internal-invariant `Error`s, no public code |
| Q8 | Malformed `CandidateRef` (`revisionKey` not a string) | Validate at the `CandidateRef` site (`INVALID_DESCRIPTOR`), so `MISSING_IMPLEMENTATION.details` never carries `undefined` |
| Q9 | `asSynaError()` typing | Superset: site details as typed by T1 + fixed `cause: { name, message }` |
| Q10 | Legacy-key diagnostics event | `{ type: 'legacy-implementation-ref', contractId, familyId, version, site }` once per Runtime read; `parse()` marks the ref with a Symbol property |
| Q11 | The waiter window under retries | Per attempt (re-armed when a new attempt starts), so the sequence-level wait bound is the 0.6 one |
| S2 | `dispose()` contract | **(i)** always fulfil (§3.2) |
| S7 | Code set | `ENV_CLOSED`, `RUNTIME_CLOSED`, `SLOT_NOT_LOADABLE`, `LIFECYCLE_MISUSE` (no `ENV_NOT_READY`: `activating` is already `OWNER_NOT_READY`) |

Approval of this document, with any changes to the recommendations above, unblocks Phase B.

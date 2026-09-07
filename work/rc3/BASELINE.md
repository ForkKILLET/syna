# 1.0.0-rc.3 Phase A — baseline, minimal public-surface increment, design decisions

Baseline commit: `d7a4410` (1.0.0-rc.2, gate COMPLETE on `46b344f`). Node 26.0.0, macOS (M4 Pro).

## 0. The audit package

`SYNA_RC3_EXECUTION_PROMPT.md` §0 names `work/rc3/audit/` (`README_ZH.md`,
`probes/core-lifecycle.mjs`, `probes/site-manager-isolated.cjs`, `evidence/*.json`) as
material the user places in the workspace. **That directory does not exist** in this
workspace, and nothing matching it was found under `~` (searched by name and by content).

The task book describes each of the six defect groups precisely enough to write the
probes from it, so the seven probes were **reconstructed from §2.1–2.5** rather than
copied, and live in `work/rc3/probes/`:

| file | probes |
|---|---|
| `work/rc3/probes/core-lifecycle.mjs` | L1, L2, L2b, L3 (`node --expose-gc`) |
| `work/rc3/probes/site-manager.mjs` | A1, A2, A3 |

Each asserts that the **defect** is present, as the audit's probes do. They are the
baseline record; the repository tests are their flipped form (§3 of the task book).

## 1. Baseline: seven probes, seven REPRODUCED on rc.2

```
$ node --expose-gc work/rc3/probes/core-lifecycle.mjs
PROBE L1 REPRODUCED — a hung Ready-slot cleanup is not bounded by the disposal grace
    grace 50 ms; dispose() still-waiting after 1001 ms; env.state=disposing
PROBE L2 REPRODUCED — a rollback cleanup that throws inside the close window is not reported by dispose()
    dispose() fulfilled; events=[]; the waiter alone saw it: true
PROBE L2b REPRODUCED — with the waiter gone the same cleanup failure is visible nowhere
    waiter=LOAD_CANCELLED; dispose() fulfilled; events=[]
PROBE L3 REPRODUCED — the ledger retains the closed Env graph through attempt.slot.ownerEnv
    ledger=1; closed Env reachable: true; its Input payload reachable: true; control Env reachable: false
core probes: 4/4 reproduced

$ node work/rc3/probes/site-manager.mjs
PROBE A1 REPRODUCED — after an owner abort, shutdown() skips clearInterval (the sweeper survives the close)
    intervals created=1, cleared=0; the sweeper fired 1 times before the close and is still firing after it (4 → 8);
    the queued acquirer settled with {"value":"SITE_MANAGER_CLOSED"} — from the capacity freed by the disposals,
    not from shutdown()'s waiter loop, which was skipped
PROBE A2 REPRODUCED — acquireTimeoutMs does not cover the configuration read
    acquireTimeoutMs=200 ms; after 1205 ms acquire() is still waiting on the store
PROBE A3 REPRODUCED — shutdown() leaves in-flight callers waiting on the store
    shutdown() returned after 0 ms; the in-flight acquirer is still waiting
application probes: 3/3 reproduced
```

A1's second half is stated honestly: on the owner-abort path the queued acquirer *is*
rejected with `SITE_MANAGER_CLOSED`, but only because disposing the records frees
capacity and `reserveCapacity` re-checks `closed` after the hand-off — `shutdown()`'s
own waiter loop never runs. A waiter that no hand-off reaches waits for its own
`acquireTimeoutMs`. The flipped test asserts the rejection comes from the shutdown.

## 2. The minimal public-surface increment (§2.0)

The ledger needs no new value: an abandoned cleanup is listed as **`abandoned`**, and
the event says which phase it was — so the increment is one union member.

| item | change | why it is necessary |
|---|---|---|
| `RuntimeEvent` | `attempt-abandoned.phase`: `'setup' \| 'rollback'` → `'setup' \| 'rollback' \| 'cleanup'` (+ its doc line) | §2.1.2 requires the report to distinguish an abandoned cleanup from an abandoned setup/rollback; no other event carries a phase |
| `RuntimeLimits` | doc of `disposalGraceMs` only | the limit now also bounds each Ready slot's cleanup phase; leaving the doc would misdescribe the limit |
| `UnsettledAttemptInspection` | doc of `state` only | `abandoned` now also covers a cleanup the close stopped waiting for (no new value, per §2.0) |

**Expected inventory diff: 0 added, 0 removed, 3 changed** (the inventory records the
full signature text including doc comments, so a doc line counts as a change). No name,
field, option or event type is added. Registered in `docs/API_STABILITY.md` as the rc.3
exception.

## 3. §2.1.5 — concurrent destruction of independent SCCs

`disposeServiceSlots` today walks `dependantFirstComponentOrder` with
`for (…) await`, so every component waits for every earlier one even when they are
independent. The condensation already carries what a scheduler needs:

1. `serviceDependencyAdjacency(disposable)` → slot → dependency slots (unchanged, it
   already sees through never-started intermediates);
2. `stronglyConnectedComponents(adjacency)` → components + `componentByNode` (unchanged);
3. from the same adjacency, condense the edges once: `dependencies[C]` = the components
   `C` depends on, and `pendingDependants[D]` = how many distinct components depend on
   `D`. (`dependantFirstComponentOrder` computes the same indegree internally; the
   scheduler needs the edge sets, so it condenses them itself and keeps the helper for
   the reference planner's snapshots, which do not change.)
4. A component is runnable when `pendingDependants === 0`. Every runnable component is
   started at once, in ascending component index (deterministic). Inside a component the
   slots keep the existing order — reverse materialization-completion — and are disposed
   **sequentially**, so every dependency chain keeps its order.
5. When a component finishes (each of its slots disposed, or its cleanup abandoned),
   `pendingDependants` of each component it depends on is decremented and those that
   reach 0 start. A slot whose cleanup is abandoned counts as finished: §2.1.2 requires
   its dependencies to be disposed anyway.

Bound: **the longest chain of the condensation × the grace**, where a chain's length is
the number of slots in the components along it (a cycle of n slots costs n grace
periods). Not "number of slots × grace". Errors keep the existing shape (one
`AggregateError` per service, collected into the Env's `AggregateError`); their order
becomes completion order instead of component order, which for a single chain is the
same order.

## 4. L3 — every strong-reference path from the ledger to an Env graph

The audit named the first. All of them are closed in this round.

| # | path | fix |
|---|---|---|
| 1 | `UnsettledRecord.attempt` → `Attempt.slot: ServiceSlot` → `slot.ownerEnv: EnvImpl` → `plan` → `inputSlots` / `slotsByNode` / `nodes` | the attempt keeps `slotId`/`revisionKey` strings and, from the moment it is listed, only a `WeakRef` to its slot (mirrors the existing `raw`/`rawRef` swap). Its owner becomes a minimal record `{ envId, closing, closeErrors }` created per Env, never the Env (see row 10 on the signal) |
| 2 | `Attempt.slot.requires` → dependency slots (Input payloads, other Envs' Service slots) → their `ownerEnv` | closed with 1: the attempt no longer holds a slot strongly |
| 3 | `FinalizationRegistry` held value `{ id, attempt }` → 1, 2 | closed with 1 (the held value stays the attempt: it must still run the cleanups) |
| 4 | the abandoned branch's late-settlement reactions `rawPromise.then(() => this.handleLateSettlement(attempt, owner, …))` — `owner` is the `EnvImpl`, and the reactions are held by the pending raw Promise | the reactions capture the attempt and its minimal owner record only |
| 5 | `registerRollingBack`'s `attempt.settled.then(...)` closure captures `slot` and the record; `settled` is the attempt's own Promise | the closure captures the record only and reaches the slot through the weak handle |
| 6 | `Attempt.pendingLoads` → `PendingLoad.target: ServiceSlot` → `ownerEnv` (kept for the wait-cycle diagnosis, never cleared on abandonment) | cleared when the attempt is listed; the diagnosis only ever reads running attempts under a live owner |
| 7 | `ServiceLifecycle.onDispose`'s closure captures `slot` — and the lifecycle object is handed to the user's `setup`, so the suspended setup frame that keeps an abandoned attempt alive reaches the Env through **our** object | the closure captures the attempt and the two strings it puts in `LIFECYCLE_MISUSE` |
| 8 | `Attempt.endRace` → the race Promise → (while pending) the `runAttempt` frame → `owner`, `slot` | already cut when the race ends (the frame returns); `endRace` is cleared on the abandoned path too, for hygiene |
| 9 | `slot.unsettledAttempt` → attempt | slot → attempt, not attempt → Env: no path out of the ledger. Kept |

| 10 | (found while implementing, not in the plan above) `AttemptOwnerRecord.signal` → `AbortSignal.reason` → the `AbortError`'s **structured stack** → the receiver of every frame that created it, the `EnvImpl` among them (V8 keeps the frames until someone reads `.stack`) | the record carries the close flag instead of the signal. A heap snapshot of the fixed build showed this was the *only* remaining path: `Materializer.unsettled → record → Attempt.owner → AbortSignal → kReason → CallSiteInfo → EnvImpl` |

`Attempt.cleanups` are the user's own closures: what they capture is the user's business
(§2.3), and the L3 test uses a setup that captures nothing.

Two notes on the minimal record. It carries no grace value: `disposalGraceMs` is a
Runtime-wide limit the Materializer already holds, so duplicating it per attempt would
add a field without a reader. And it does **not** carry the owner's `AbortSignal`,
although §2.3 lists one: path 10 above shows a signal transitively retains the Env
through its abort reason's stack, which is exactly what L3 forbids. The close flag is
what a listed attempt needs; live code takes the signal from the owner it already has,
and `setup()` still receives it in its lifecycle unchanged.

## 5. What Phase A did not find

No seventh problem. Nothing in the six fixes requires changing a public name, and the
concurrent destruction keeps every dependency chain's order, so neither of the two
stop-and-report conditions of §4 applies. Continuing with Phase B.

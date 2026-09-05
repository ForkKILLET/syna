# Promise semantics & lifecycle audit — Syna v0.5 core

Independent adversarial audit of `packages/core` restricted to Promise semantics and lifecycle: catch/degrade, background loads, `Promise.race`, late resolution, cancellation interleavings, retry/recovery, cleanup failures, disposal ordering, stop signals, deadlines. Findings are reproductions and mechanisms, not scores.

## Environment

- Node `v26.0.0`, macOS (Darwin 25.2.0)
- Source snapshot: `git rev-parse HEAD` = `0240b6f736142bbe4bad48ee8ee999ebc05b2cfc` (the working directory itself reports "not a git repo"; this hash is what `git rev-parse HEAD` printed from the workspace)
- Library under test: prebuilt `packages/core/dist/index.js` (not rebuilt by this audit)
- Spec read against: `SYNA_V05_EXECUTION_PROMPT.md` §6, §7 (K02, K07, K08, K09, K10), §9 (R02, R03, R04, R09, R10, R11); `docs/SEMANTIC_CHANGES_V05.md` §2, §4
- Implementation read: `packages/core/src/runtime.ts`, `src/internal/materializer.ts`, `src/internal/abort.ts`, `src/internal/runtime-model.ts`, `src/graph.ts`, relevant parts of `src/internal/graph-builder.ts`, `src/definition.ts`, `src/descriptors.ts`

## Probes

All probes live in `work/v05/audit/promise-lifecycle/` and run with `node work/v05/audit/promise-lifecycle/<name>.probe.mjs`. Each prints `PASS`/`FAIL` per case with the observed value, uses deferreds/latches and small `setupDeadlineMs`/`initialization.deadlineMs`/`disposal.graceMs`, and has a watchdog so it always exits. `FAIL` lines are the reproductions of the findings below (a FAIL is the *spec expectation* not holding, not a probe error).

| Probe | Attack | Result | FAIL lines map to |
|---|---|---|---|
| `01-unawaited-load.probe.mjs` | 1 un-awaited `load()` in setup, dep fails later | 6/6 | (observations feed F-PL-06) |
| `02-race-fallback.probe.mjs` | 2 `Promise.race` fallback, late resolve/reject, dispose while pending | 11/12 | F-PL-01 (case D) |
| `03-deadline-unsettled.probe.mjs` | 3 never-settling setup, UNSETTLED_ATTEMPT, late events, recovery, dispose report, `env.state` | 16/19 | F-PL-02 (case D), F-PL-04 (case C) |
| `04-waiter-abort.probe.mjs` | 4 two waiters, one aborts; pre-aborted signal; abort during backoff | 9/9 | (observation feeds F-PL-07) |
| `05-retry-backoff.probe.mjs` | 5 retry `attempts:3 delayMs:200`, dispose in backoff, throwing rollback, cooldown | 14/14 | — |
| `06-eager-failure.probe.mjs` | 6 eager failure during `enter()`, siblings, `rootEnvCount`, lazy sibling, `runtime.dispose()` mid-enter, child eager failure | 19/20 | F-PL-01 (`enter()` latency) |
| `07-dispose-order.probe.mjs` | 7 chain A→B→C late-loaded, dormant intermediate, SCC both orders, throwing cleanup, no dormant start | 8/9 | F-PL-05 (case B) |
| `08-stop-signal.probe.mjs` | 8 signal-before-cleanup, child/parent concurrent dispose, sequential descendant disposal | 6/10 | F-PL-03 (case C) |
| `09-bound-entry.probe.mjs` | 9 BoundEntry OWNER_NOT_READY / Ready / lazy / disposed owner / anchor at owner not request child | 13/13 | — |
| `10-reentrancy.probe.mjs` | 10 self-load, sync throw, rejected promise, stale `onDispose`, thenable instance | 11/11 | — |
| `11-late-completion.probe.mjs` | 11 late resolve/reject after closing, retry in flight, parent closes during child activation | 12/12 | — |
| `12-misc.probe.mjs` (run with `--unhandled-rejections=strict`) | 12 unhandled rejections, timers after `runtime.dispose()`, disposed-child handle, duplicate events, state strings | 12/12 | (observation feeds F-PL-08) |
| `13-edges.probe.mjs` | `setupDeadlineMs: Infinity` + stuck setup vs `dispose()`; `run()` with pending `preload()`; dependant cleanup uses dependency; `loadAll` partial failure | 4/6 | F-PL-01 (cases A, B) |

## Findings

### F-PL-01 — `dispose()` / `run()` / failed `enter()` wait for the full initialization deadline of every in-flight owned attempt before `disposal.graceMs` applies; with `setupDeadlineMs: Infinity` disposal never returns

- **Severity:** major
- **Trigger:** an Env begins closing while one of its owned slots is in state `starting` with a setup that does not settle on its own (it does not observe `lifecycle.signal`). Typical sources: a `Promise.race([dep.load(), timeout])` fallback whose losing `dep.load()` is still running; an un-awaited background `load()`/`preload()`; an eager sibling of a failing eager slot; `run()` callbacks that leave a `preload()` pending.
- **Expected:** `docs/SEMANTIC_CHANGES_V05.md` §4: "关闭：先置 disposing 并 abort signal（拒绝新工作、广播取消），再等 descendants，再等已登记 attempt（**最多 `disposal.graceMs`**），然后 dependant-first 清理。仍未结束的 attempt 标记 `abandoned`，dispose() 以 `UNSETTLED_ATTEMPT` 报告". K08: "对不合作 setup，调用者可以超时，但关闭状态和报告必须承认未结束资源". `descriptors.ts` documents `graceMs` as "How long disposal waits for a timed-out setup attempt to actually settle".
- **Observed:**
  - `02-race-fallback` case D: `initialization.deadlineMs: 600`, `disposal.graceMs: 20`, dep slot `starting` → `env.dispose()` took **617 ms**, then rejected with `UNSETTLED_ATTEMPT`.
  - `06-eager-failure`: eager setup throws after `void lazy.load()` on a never-settling sibling; `deadlineMs: 300`, `graceMs: 30` → `runtime.enter()` rejected after **337 ms** (with the default 30 000 ms deadline this `enter()` rejection would take ~30 s; the first version of the probe hit its 12 s watchdog).
  - `13-edges` case B: `runtime.run(Entry, ({ slow }) => { slow.preload(); return 'done' })` with `deadlineMs: 300` → `run()` settled after **322 ms**.
  - `13-edges` case A: `setupDeadlineMs: Infinity` (documented as "disables it") and `setup: () => new Promise(() => {})` → `env.dispose()` still pending after 400 ms; `env.state` stays `disposing`. Nothing will ever resolve it: `runtime.dispose()` would hang the same way.
- **Mechanism:** `Materializer.settleSlots` (materializer.ts) first does `for slot of slots: if (slot.sequence && slot.state === 'starting') await slot.sequence` with no bound; `slot.sequence` only settles when the raw setup promise settles or `raceDeadline` fires. The `graceMs` window (`settlesWithin(attempt.settled, disposalGraceMs)`) is applied afterwards and only to attempts that have *already* timed out (`slot.unsettledAttempt`). So the effective shutdown bound is `deadlineMs + graceMs`, and with an infinite per-service deadline there is no bound at all. Cooperative setups (awaiting `signal`) are unaffected, which is why the existing tests pass.
- **Minimal probe:** `13-edges.probe.mjs` case A; `02-race-fallback.probe.mjs` case D.
- **Scope:** every closing path (`env.dispose()`, `runtime.dispose()`, `executeStructured` behind `run()`, the rollback inside a failed `enter()`). Not a correctness bug in what is eventually reported (abandonment *is* reported once reached), but the documented `graceMs` contract does not hold, default settings stall shutdown up to 30 s, and `Infinity` turns a non-cooperative setup into an unrecoverable hang of `dispose()`.

### F-PL-02 — `onDispose()` called after the attempt's deadline fired throws `INVALID_ENV_STATE`; the late-created resource is never cleaned up

- **Severity:** major
- **Trigger:** the ordinary pattern `const conn = await connect(); onDispose(() => conn.close()); return conn` when `connect()` takes longer than `setupDeadlineMs`/`initialization.deadlineMs`.
- **Expected:** K08: "迟到结果不能覆盖新的状态/已关闭 Env；处理 cleanup 并报告". SEMANTIC_CHANGES §4: "迟到结果被丢弃、其 `onDispose` 清理被执行、通过 `diagnostics.onEvent` 报告（`late-setup-result` / `late-setup-failure`）". K09: "onDispose 只负责自己创建的资源". A late setup must still be able to hand its own resources to the runtime for cleanup.
- **Observed** (`03-deadline-unsettled` case D): waiter got `INITIALIZATION_TIMEOUT`; when the setup resumed, `onDispose()` threw `SynaError(INVALID_ENV_STATE: "onDispose() for a3.late-ondispose/conn@1.0.0 may only be called during its active setup attempt.")`; the setup therefore rejected with the runtime's own error; the diagnostics event was `late-setup-failure` with `error.code === 'INVALID_ENV_STATE'` and `cleanupErrors: []`; `closed === false` — the connection leaked and the report blames the user's setup for a failure the runtime injected.
- **Mechanism:** `runAttempt` in materializer.ts: `lifecycle.onDispose` requires `slot.attempt === attempt && attempt.state === 'running'`. On deadline expiry `attempt.state = 'timed-out'` and `runSequence`'s `catch` deletes `slot.attempt`, so any `onDispose()` from the still-running setup is refused. `handleLateSettlement` does run `attempt.cleanups`, but only those registered *before* the deadline.
- **Minimal probe:** `03-deadline-unsettled.probe.mjs` case D.
- **Scope:** every timed-out attempt whose setup acquires resources after the deadline point. This is the common ordering (acquire, then register), so INITIALIZATION_TIMEOUT routinely leaks the very resource that was slow. Registering cleanup before awaiting avoids it, but nothing in the API or docs says so.

### F-PL-03 — Ancestor disposal does not broadcast cancellation to, or refuse new work from, descendants before waiting: they are closed one at a time

- **Severity:** major (semantic; nothing leaks in the end)
- **Trigger:** an Env with ≥2 children (or a runtime with ≥2 roots) is disposed while an earlier sibling's cleanup (or descendant tree) is slow.
- **Expected:** K09: "关闭先拒绝新工作并广播取消，再等 descendants 和已登记工作结束". SEMANTIC_CHANGES §4: "先置 disposing 并 abort signal（拒绝新工作、广播取消），再等 descendants". R10: "owner停止信号先到达等它退出的child".
- **Observed** (`08-stop-signal` case C; root with child1 {slow cleanup} and child2 {lazy, watcher}; `root.dispose()` blocked inside child1's cleanup):
  - `child2.state === 'ready'`; the `abort` listener of child2's `watcher` had not fired (`events` = `["c1-cleanup-start"]`).
  - `child2.deps.lazy.load()` **started a new setup** and resolved `{ lazy: true }` during the ancestor's shutdown.
  - `child2.derive()` **created a new Env `env-4`** during the ancestor's shutdown (it was later disposed when the loop reached child2).
  - Final event order: `c1-cleanup-start, lazy-start, c1-cleanup-end, c2-signal, lazy-cleanup, watcher-cleanup`.
- **Mechanism:** `RuntimeImpl.disposeEnv` sets `state = 'disposing'` and aborts *its own* controller, then `for (const child of [...env.children]) await child.dispose()` sequentially; a child's state flips and its signal aborts only when its turn comes. `runtime.dispose()` iterates roots the same way, so the runtime-level `disposed` flag blocks new `enter()` but not new work inside not-yet-reached roots.
- **Minimal probe:** `08-stop-signal.probe.mjs` case C.
- **Scope:** any tree with more than one descendant. Workers in later siblings do not begin winding down concurrently (shutdown time is the sum, not the max), and per-request children keep accepting/creating work during an app shutdown. R10's "signal first" guarantee holds only within a single Env.

### F-PL-04 — After a disposal that abandoned an attempt, `env.state` is `'disposed'` and the Env leaves `rootEnvCount`/`liveEnvCount`

- **Severity:** minor
- **Trigger:** `dispose()` on an Env owning a slot whose timed-out attempt never settles within `graceMs`.
- **Expected:** K08: "关闭状态和报告必须承认未结束资源，不能提前叫完全 Disposed". SEMANTIC_CHANGES §4: "dispose() 以 `UNSETTLED_ATTEMPT` 报告——不宣称完全 Disposed".
- **Observed** (`03-deadline-unsettled` case C): `dispose()` rejected with `AggregateError[UNSETTLED_ATTEMPT]` and the slot reads `abandoned` (honest), but `env.state === 'disposed'` and `runtime.inspect()` reports `rootEnvCount 0 / liveEnvCount 0`. A subsequent `runtime.dispose()` **fulfils** silently because `disposeEnv` removed the root from `roots` before throwing.
- **Mechanism:** `disposeEnv` unconditionally sets `env.state = 'disposed'` and removes the Env from `roots`/`envById` before pushing the `UNSETTLED_ATTEMPT` error. `EnvState` has no value for "disposed with abandoned attempts".
- **Minimal probe:** `03-deadline-unsettled.probe.mjs` case C.
- **Scope:** observability only; the rejection carries the truth, but anything that inspects `env.state`/`inspect()` after catching (or after a `runtime.dispose()` that follows) sees a fully-disposed world.

### F-PL-05 — Disposal order ignores a transitive dependency that passes through a never-started (dormant) slot

- **Severity:** minor / limitation
- **Trigger:** A requires B, B requires C; A and C are Ready, B was never loaded (C reached through another root or ref).
- **Expected:** K09: "Ready 后运行时才加载的依赖，也要符合最终依赖清理顺序"; dependant-first over the dependency DAG.
- **Observed** (`07-dispose-order` case B): slots `c=slot-1:ready, a=slot-2:ready, b=slot-3:dormant`; cleanup order `["C","A"]` — the dependency C is closed before its transitive dependant A.
- **Mechanism:** `serviceDependencyAdjacency.collect` returns as soon as it reaches a service slot; if that slot is not in the Ready set (dormant B) its own `requires` are not traversed, so the edge A→C is lost and the two become independent components ordered by component index (Tarjan visit order over sorted `slot-N` ids).
- **Minimal probe:** `07-dispose-order.probe.mjs` case B.
- **Scope:** A cannot obtain C's instance through Syna refs without materializing B, so this only bites when instances are shared out-of-band. The normal late-loaded chain (case A) and SCCs (case C) are ordered correctly.

### F-PL-06 — A rejected, un-awaited `load()` is reported as an unhandled rejection only on some code paths

- **Severity:** minor
- **Trigger:** user code calls `ref.load()` without `await`/`.catch` (the spec explicitly makes this "the user's problem").
- **Expected:** §6/K07: "`.load()` 只取得预定 slot 并返回普通 Promise" — ordinary JavaScript semantics, i.e. an unhandled rejection should surface consistently (or consistently not).
- **Observed** (`01-unawaited-load`): the un-awaited `load()` that *joined the running attempt* rejected with `"dep failed late"` and produced **0** `unhandledRejection` events; an identical un-awaited `load()` on the *already failed* slot produced **1**. (`load({ signal })` returns a fresh promise and would also surface.)
- **Mechanism:** `startSequence` attaches `void sequence.catch(() => undefined)` to `slot.sequence` and `loadService` hands that very promise back to the caller when no signal is given, so Node considers its rejection handled; `serviceValue` for a `failed` sticky slot returns a fresh `Promise.reject(slot.error)` with no handler.
- **Minimal probe:** `01-unawaited-load.probe.mjs`.
- **Scope:** diagnostics only; under `--unhandled-rejections=strict` a forgotten `.catch` crashes or is silently swallowed depending on timing, which makes the R03 "Helper 内不 await 的后台 load" pattern's mistakes harder to find.

### F-PL-07 — `load({ signal })` with an already-aborted signal still starts the dormant slot

- **Severity:** minor
- **Trigger:** `ref.load({ signal: AbortSignal.abort() })` on a dormant slot.
- **Expected:** K08: "一个 caller abort/timeout 只结束自身等待，不取消其他使用者共享的 attempt" — not violated; but a pre-aborted caller never wanted the wait, and `fetch`-style APIs reject without starting work.
- **Observed** (`04-waiter-abort`): the call rejected `LOAD_CANCELLED` and `setup` ran once (`starts === 1`).
- **Mechanism:** `loadService` calls `serviceValue(slot)` (which calls `startSequence`) before `waitWithSignal` checks `signal.aborted`.
- **Minimal probe:** `04-waiter-abort.probe.mjs` second case.
- **Scope:** wasted work and a surprising side effect; a design choice rather than a spec breach.

### F-PL-08 — A disposed child Env handle can still start parent-owned dormant slots (uncertain: possibly intended)

- **Severity:** minor (uncertain)
- **Trigger:** `child.dispose()` then `child.deps.shared.load()` where `shared` is inherited from (owned by) the still-live parent.
- **Expected:** not stated explicitly. K08 "owner dispose 禁止新尝试" refers to the owner (the parent here, which is alive). K02 says external code only gets "Entry requires 的类型化表面"; a disposed handle continuing to act as a locator into the parent is at least surprising.
- **Observed** (`12-misc` case C): `child.state === 'disposed'`, `load()` fulfilled `{ shared: true }`, `starts === 1`.
- **Mechanism:** `DependencyRef`s are bound to slots, not to the Env handle that exposed them; only slot/owner state is checked.
- **Minimal probe:** `12-misc.probe.mjs` case C.
- **Scope:** design question for the maintainers; flagged, not inflated.

### Observation (not a finding) — a timed-out (dead) attempt can still start dormant sibling slots while the owner is alive

`10-reentrancy` case E: after `INITIALIZATION_TIMEOUT`, the still-running setup resumed and its `side.load()` started and completed the sibling slot (`sideStarts 1`, state `ready`). K08 only forbids new attempts after *owner* dispose, so this is within spec, but the result is a Ready resource that no consumer will ever obtain through the dead attempt.

## Verified expectations (behaved per spec)

- **Attack 1 (K07/R02/R03):** un-awaited `load()` inside setup is a background operation; the consumer is Ready while the dependency is `starting`; the dependency's later failure is sticky on its own slot and does **not** poison the Ready consumer; a later `load()` of the consumer returns the identical instance; the dependency setup ran once.
- **Attack 2 (R04):** `Promise.race([dep.load(), timeout])` fallback works; late resolve makes the dependency Ready without touching the consumer; late reject is a normal sticky failure; when the owner closes while the dependency is pending and the setup cooperates with `signal`, the instance is discarded, its cleanup runs after the signal, and the waiter gets `INVALID_ENV_STATE` "…the instance was discarded".
- **Attack 3 (K08):** never-settling setup → `INITIALIZATION_TIMEOUT` with `attempt`, `deadlineMs`, `elapsedMs`, `pendingLoads`, and an explicit "not a proof of deadlock" note; sticky policy: a second `load()` re-reports the same timeout and starts nothing; `retry-on-next-load`: a second `load()` gets `UNSETTLED_ATTEMPT` while the raw promise is pending, still one setup invocation; late resolution → cleanups registered before the deadline run, exactly one `late-setup-result`; recovery then starts exactly one new attempt shared by concurrent waiters; a sticky slot stays failed after the late result; `dispose()` with small `graceMs` reports `UNSETTLED_ATTEMPT` inside an `AggregateError`, emits one `attempt-abandoned`, slot reads `abandoned`; repeated `dispose()` returns the same memoised rejection.
- **Attack 4 (R10):** aborting one waiter rejects only it with `LOAD_CANCELLED`; the attempt keeps running; the patient waiter receives the instance; the aborted waiter never later receives it; abort during retry backoff also only ends that wait and the sequence continues.
- **Attack 5 (R09):** dispose during a 200 ms backoff returns in ~1 ms with `INVALID_ENV_STATE` "…cancelled because owner Env … is closing" and no further attempt; a throwing rollback cleanup ends the sequence with `AggregateError([businessError, rollbackError], { cause: businessError })`, no retry, sticky; recovery cooldown is cancelled by dispose and joined waiters are cancelled too; a timed-out attempt is not retried (no overlap).
- **Attack 6 (K09):** eager failure during `enter()` → `ENTRY_ACTIVATION_FAILED` with `cause` = the setup error; eager siblings that were Ready are cleaned up; a slow eager sibling sees the stop signal, is discarded on completion and cleaned; an awaited lazy sibling is cleaned; an un-awaited never-settling lazy sibling is reported `attempt-abandoned` and `UNSETTLED_ATTEMPT` appears in `error.suppressed`, and its late settlement still runs its cleanup with a `late-setup-result`; `rootEnvCount`/`liveEnvCount` are 0 afterwards; `runtime.dispose()` during a pending `enter()` makes it reject `ENTRY_ACTIVATION_FAILED` (cause mentions "discarded"), signal seen before cleanup; a child's eager failure leaves the parent Ready and parent-owned slots untouched.
- **Attack 7 (K09/R19):** chain A→B→C with C loaded lazily after A Ready disposes A, B, C; SCC X↔Y disposes in reverse completion order for both completion orders; a throwing cleanup does not stop other cleanups (reverse registration inside a slot, dependant before dependency), all errors are aggregated per slot and per Env; `load()` of a dormant slot from a cleanup rejects `INVALID_ENV_STATE` and starts nothing; all slots end `disposed`.
- **Attack 8 (R10), per-Env part:** a cleanup that awaits `signal` sees the abort first (no deadlock); a child disposing concurrently with its parent shares one disposal, child cleanup completes before parent cleanup, no double cleanup.
- **Attack 9 (K02/K10/R08):** `handle.enter()` from an eager setup rejects `OWNER_NOT_READY` (caught inside setup; owner still became Ready); `handle.check()` is allowed while activating; after Ready the same handle works and the child is parented at the owner; `enter()` from a lazy setup in a Ready owner works; a handle reached through a request child — including when the Service is first materialized from the request child — is anchored at the slot owner (root), the bound child survives the request child's disposal and is taken down by the root's; during and after owner disposal `enter()`/`check()` reject `INVALID_ENV_STATE`.
- **Attack 10:** self-load hits `INITIALIZATION_TIMEOUT` with `suspectedWaitCycle [self, self]`, and the self-waiting setup settles once its sequence rejects (no abandoned attempt); synchronous throw and rejected promise surface the original error types with cleanups run and sticky failure; `onDispose` after setup finished, and a stale lifecycle used from another slot's setup, throw `INVALID_ENV_STATE`; non-function → `TypeError`; a thenable instance emits `foreign-thenable-setup`.
- **Attack 11 (K08):** late resolve after closing → instance discarded, cleanup once, waiter gets `INVALID_ENV_STATE` mentioning "discarded", slot ends `disposed`; late reject → waiter gets the business error, cleanup runs; retry policy does not retry once the owner began closing; parent disposing during child activation → `ENTRY_ACTIVATION_FAILED`, eager instance discarded, no live Envs.
- **Attack 12:** under `--unhandled-rejections=strict`, timeouts, `UNSETTLED_ATTEMPT` recovery refusals, `preload()` on a blocked slot, double eager failures, late failures and failed disposals produced zero unhandled rejections; no `Timeout` handles remained after `runtime.dispose()` (including after an abandoned attempt); concurrent/repeated `dispose()` share one rejection; `attempt-abandoned`/`late-setup-failure` emitted exactly once; an activating root is counted in `rootEnvCount`; Ready means all owned eager slots Ready.
- **Extra (K07/K09):** a dependant's cleanup can still `load()` and use its dependency (dependency closed afterwards); `loadAll` partial failure is a plain catchable rejection and the healthy member stays Ready.

## Remaining risk / not covered

- Real timers (5–600 ms) rather than a fake clock; timing-based checks have generous margins but are not scheduler-exhaustive. No randomized/property interleavings were run.
- Not probed: actual host worker threads / `run()`-driven worker loops beyond the `signal` semantics; `C.all`/selector members and `override`d services interacting with attempts and disposal; nested SCCs mixed with dormant members (only the two-node SCC and the dormant-intermediate DAG); memory retention of abandoned slots (`ServiceSlot.ownerEnv` keeps the disposed Env reachable — not measured); `await using` syntax for `Symbol.asyncDispose`; `loadAll` with Inputs; cross-Runtime anchors; plan-cache interactions with lifecycle.
- F-PL-01's `Infinity` case could only be shown as "still pending after 400 ms" — by construction nothing can prove it never returns; the mechanism (no bound in `settleSlots`) is the evidence.
- F-PL-08 is flagged as a design question, not asserted as a defect.

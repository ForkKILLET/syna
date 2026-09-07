import type {
  Awaitable,
  ServiceRef,
  InputRef,
  LoadOptions,
  RuntimeEvent,
  ServiceLifecycle,
  UnsettledAttemptInspection,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { stronglyConnectedComponents } from '../graph.js'
import type {
  AttemptOwnerRecord,
  DisposableError,
  InputSlot,
  PendingLoad,
  RuntimeSlot,
  ServiceSlot,
  SetupAttempt,
  SetupWaiter,
  SlotOwnerEnv,
} from './runtime-model.js'
import {
  type ClosedEnvDetails,
  closedError,
  settlesWithin,
  sleepAbortable,
  waitWithSignal,
} from './abort.js'

export interface MaterializerOptions {
  readonly deadlineMs: number
  readonly disposalGraceMs: number
  readonly onEvent: (event: RuntimeEvent) => void
}

type AttemptOutcome =
  | { readonly ok: true; readonly instance: unknown }
  | {
      readonly ok: false
      readonly error: unknown
      /** The raw setup Promise is still pending (the owner's close ended the wait); never retried. */
      readonly unsettled: boolean
      readonly cleanupErrors: readonly unknown[]
    }

type RaceResult =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'unreachable' }

/**
 * Ledger entry for something the Runtime stopped waiting for: an attempt whose
 * raw Promise is pending after a waiter's deadline (`overdue`: the attempt is
 * overdue and still running under a live owner) or after its owner's close
 * (`abandoned`), an attempt whose setup ended but whose rollback outlived the
 * close (`rolling-back`), one whose late result is being cleaned up
 * (`settling`), or the cleanup phase of a Ready slot that outlived its own
 * budget (`abandoned`, with no attempt of its own: `attempt-abandoned` reports
 * it with `phase: 'cleanup'`). The record holds the attempt strongly, and that
 * retains nothing beyond the documented bound: a listed attempt holds the
 * user's raw Promise only weakly, so that Promise's reachability alone decides
 * how long the record lives — when the Promise is collected the attempt is
 * closed as unreachable and the record dropped. (A weak reference here let the
 * attempt die in the same collection as the Promise, so nothing was left to run
 * its cleanups when the unreachable path fired.)
 */
interface UnsettledRecord {
  readonly id: number
  /** Absent for an abandoned cleanup: nothing is executing a `setup()` there. */
  readonly attempt: SetupAttempt | undefined
  readonly slot: string
  readonly revision: string
  readonly env: string
  readonly startedAt: number
  state: UnsettledAttemptInspection['state']
  /** The close in progress once the attempt settled late or was found unreachable. */
  closing?: Promise<void>
}

/** What the finalization registry hands back: the attempt itself, so the unreachable close can run its cleanups. */
interface UnreachableToken {
  readonly id: number
  readonly attempt: SetupAttempt
}

function isForeignThenable(value: unknown): boolean {
  if (value instanceof Promise) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Settles with the raw result, with `abandoned` when disposal stops waiting
 * first, or with `unreachable` when the raw Promise was garbage-collected
 * unsettled first. Whichever comes first wins; the raw Promise itself is never
 * cancelled. No deadline runs here: the deadline belongs to each waiter. The
 * early ends come in through `attempt.endRace`, so the race allocates nothing
 * but its own Promise and the two reactions on the raw one (which also observe
 * a rejection: the Runtime leaves none unhandled). Nothing returned here
 * references the raw Promise.
 */
function raceAttempt(promise: Promise<unknown>, attempt: SetupAttempt): Promise<RaceResult> {
  // The reactions close over the resolver alone: a closure that mentioned
  // `promise` would keep it reachable through `attempt.endRace` for as long as
  // the attempt lives, and the unreachable diagnosis could never fire.
  let resolve!: (result: RaceResult) => void
  const race = new Promise<RaceResult>(settle => { resolve = settle })
  attempt.endRace = kind => resolve({ kind })
  promise.then(
    value => resolve({ kind: 'resolved', value }),
    error => resolve({ kind: 'rejected', error }),
  )
  return race
}

/**
 * One execution of `setup()` (see `SetupAttempt`). Every instance has the same
 * shape; `settled` is created only when something waits for it, and the race's
 * early end is a function on the attempt rather than a Promise per outcome.
 */
class Attempt implements SetupAttempt {
  readonly startedAt = Date.now()
  state: SetupAttempt['state'] = 'running'
  overdueAt?: number
  readonly cleanups: Array<() => Awaitable<void>> = []
  readonly pendingLoads = new Map<number, PendingLoad>()
  rawSettled = false
  raw: Promise<unknown> | undefined = undefined
  rawRef?: WeakRef<Promise<unknown>>
  slot: ServiceSlot | undefined
  slotRef?: WeakRef<ServiceSlot>
  readonly slotId: string
  readonly revisionKey: string
  endRace: ((kind: 'abandoned' | 'unreachable') => void) | undefined = undefined
  watched = false
  reportsToClose = true
  private isSettled = false
  private settledPromise: Promise<void> | undefined = undefined
  private resolveSettledPromise: (() => void) | undefined = undefined

  constructor(readonly id: number, slot: ServiceSlot, readonly owner: AttemptOwnerRecord) {
    this.slot = slot
    this.slotId = slot.id
    this.revisionKey = slot.service.key
  }

  get settled(): Promise<void> {
    if (this.isSettled) return Promise.resolve()
    return (this.settledPromise ??= new Promise<void>(resolve => { this.resolveSettledPromise = resolve }))
  }

  resolveSettled(): void {
    this.isSettled = true
    this.resolveSettledPromise?.()
  }
}

/**
 * The deadlines of every armed waiter in the process: a list sorted by expiry
 * (a new wait usually expires last, so insertion starts at the tail) behind
 * one timer set for the earliest expiry. A wait that settles before its
 * deadline — nearly all of them — costs a few pointer writes and never a timer
 * of its own; the timer is re-set earlier only when an earlier expiry arrives.
 * When it fires it times out the earliest due waiter and lets that timeout's
 * consequences run (the rejection chain that settles every other waiter of the
 * same sequence, as when each waiter had a timer of its own and Node drained
 * the microtasks between two of them) before the next due waiter is looked at
 * from a `setImmediate`. While no waiter is queued the timer is `unref`ed, so
 * the queue holds the process alive exactly as long as pending waits do.
 */
class DeadlineQueue {
  private head: SetupWaiter | undefined = undefined
  private tail: SetupWaiter | undefined = undefined
  private queued = 0
  private timer: ReturnType<typeof setTimeout> | undefined = undefined
  /** The expiry the timer is set for; `Infinity` while there is no timer. */
  private target = Infinity

  add(waiter: SetupWaiter, expiresAt: number): void {
    if (waiter.queued) this.unlink(waiter)
    waiter.expiresAt = expiresAt
    waiter.queued = true
    let after = this.tail
    while (after !== undefined && after.expiresAt > expiresAt) after = after.prev
    waiter.prev = after
    waiter.next = after === undefined ? this.head : after.next
    if (waiter.next !== undefined) waiter.next.prev = waiter
    else this.tail = waiter
    if (after !== undefined) after.next = waiter
    else this.head = waiter
    if (this.queued++ === 0) this.timer?.ref()
    if (expiresAt < this.target) this.arm(expiresAt)
  }

  remove(waiter: SetupWaiter): void {
    if (!waiter.queued) return
    this.unlink(waiter)
    if (--this.queued === 0) this.timer?.unref()
  }

  private unlink(waiter: SetupWaiter): void {
    if (waiter.prev !== undefined) waiter.prev.next = waiter.next
    else this.head = waiter.next
    if (waiter.next !== undefined) waiter.next.prev = waiter.prev
    else this.tail = waiter.prev
    waiter.prev = undefined
    waiter.next = undefined
    waiter.queued = false
  }

  private arm(expiresAt: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.target = expiresAt
    this.timer = setTimeout(this.fire, Math.max(0, expiresAt - performance.now()))
  }

  private readonly fire = (): void => {
    // A deferred continuation may find a timer that an `add` armed meanwhile;
    // the head decides afresh what the next timer is.
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.target = Infinity
    const head = this.head
    if (head === undefined) return
    const now = performance.now()
    if (head.expiresAt > now) {
      this.arm(head.expiresAt)
      return
    }
    this.remove(head)
    try {
      head.onDeadline(head)
    }
    finally {
      const next = this.head
      if (next !== undefined) {
        if (next.expiresAt <= now) setImmediate(this.fire)
        else this.arm(next.expiresAt)
      }
    }
  }
}

const deadlines = new DeadlineQueue()

/**
 * Owns every operational concern of Service slots: attempts, waiters, retry,
 * recovery, deadlines and cleanup ordering. Topology is decided elsewhere; the
 * materializer can only realize already-created slots.
 *
 * `load()` returns a plain Promise of its own for every caller: a waiter on the
 * slot's current setup sequence. The setup deadline is the waiter's — it ends
 * that one wait, never the attempt. No completion barrier is attached to the
 * caller; whether the caller awaits the Promise is ordinary JavaScript.
 */
export class Materializer {
  private nextAttemptId = 1
  private nextLoadId = 1
  private nextWaiterId = 1
  private completionCounter = 1
  private readonly unsettled = new Map<number, UnsettledRecord>()
  /**
   * Fires when the raw setup Promise of an overdue or abandoned attempt is
   * garbage-collected: nothing can settle it any more, so the attempt is closed
   * as failed (its registered cleanups run) instead of staying pending forever.
   */
  private readonly unreachable = new FinalizationRegistry<UnreachableToken>(token => this.attemptUnreachable(token))

  private readonly onDeadline = (waiter: SetupWaiter): void => this.waiterTimedOut(waiter)

  constructor(private readonly options: MaterializerOptions) {}

  /** Every attempt the Runtime is still waiting on, oldest first. */
  unsettledAttempts(): readonly UnsettledAttemptInspection[] {
    return this.ledgerView(() => true)
  }

  /** The attempts an Env's close left behind: its own slots' attempts that are abandoned, rolling back or settling. */
  abandonedAttemptsOf(envId: string): readonly UnsettledAttemptInspection[] {
    return this.ledgerView(record => record.env === envId && record.state !== 'overdue')
  }

  private ledgerView(include: (record: UnsettledRecord) => boolean): readonly UnsettledAttemptInspection[] {
    const now = Date.now()
    const views: UnsettledAttemptInspection[] = []
    for (const record of this.unsettled.values()) {
      if (!include(record)) continue
      views.push(Object.freeze({
        attemptNumber: record.id,
        slot: record.slot,
        revision: record.revision,
        env: record.env,
        state: record.state,
        elapsedMs: now - record.startedAt,
      }))
    }
    return Object.freeze(views)
  }

  /**
   * Waits, up to `graceMs`, for the attempts whose late close (the cleanups
   * after a late result or an unreachable Promise) is in progress; whatever is
   * still outstanding afterwards stays in the ledger for the caller to report.
   */
  async awaitSettling(graceMs: number): Promise<void> {
    const closing = [...this.unsettled.values()].flatMap(record => (record.closing ? [record.closing] : []))
    if (closing.length > 0) await settlesWithin(Promise.all(closing), graceMs)
  }

  createRef<T>(slot: RuntimeSlot, requester?: SetupAttempt): ServiceRef<T> {
    return Object.freeze({
      load: (options?: LoadOptions) => this.load(slot, options, requester) as Promise<T>,
    })
  }

  createInputRef<T>(slot: InputSlot): InputRef<T> {
    return Object.freeze({
      read: () => slot.payload as T,
    })
  }

  load(slot: RuntimeSlot, options?: LoadOptions, requester?: SetupAttempt): Promise<unknown> {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
      return Promise.reject(new TypeError('load() options must be an object.'))
    }
    switch (slot.kind) {
      case 'input': return Promise.resolve(slot.payload)
      case 'binding': return this.load(slot.requires.get('target')!, options, requester)
      case 'all-implementations':
      case 'entry': return Promise.resolve(slot.value)
      case 'service': return this.loadService(slot, options, requester)
    }
  }

  /**
   * Starts every given eager slot and resolves when all are Ready; rejects with
   * the first failure. The activation is the waiter of each eager attempt, so
   * an eager setup that outlasts the deadline fails the activation with
   * `LOAD_TIMEOUT` while the attempt keeps running; the rollback
   * that follows closes the new Env, and that close is what discards the late
   * result.
   */
  async startEagerSlots(slots: readonly ServiceSlot[]): Promise<void> {
    await Promise.all(slots.map(slot => this.loadService(slot, undefined, undefined)))
  }

  /**
   * Gives every in-flight attempt of the given slots at most `limits.disposalGraceMs`
   * to settle after the owner's stop signal: running sequences, overdue or
   * not. Slots are waited for concurrently, so the whole step is bounded by
   * one grace period regardless of the per-service `loadTimeoutMs` (even
   * `Infinity`). Attempts that do not settle in time are abandoned: their slot
   * is marked `abandoned`, the attempt stays registered as `unsettledAttempt`
   * and in the ledger, `attempt-abandoned` is reported, and its late result is
   * still discarded, cleaned up and reported when it eventually arrives. The
   * owner's close does not wait for that: its state is the Runtime's to set.
   */
  async settleSlots(slots: readonly ServiceSlot[]): Promise<void> {
    await Promise.all(slots.map(slot => this.settleSlot(slot)))
  }

  private async settleSlot(slot: ServiceSlot): Promise<void> {
    const graceMs = this.options.disposalGraceMs
    const startedAt = Date.now()
    if (slot.state === 'starting' && slot.sequence) {
      if (!(await settlesWithin(slot.sequence, graceMs))) {
        const running = slot.attempt
        slot.state = 'abandoned'
        // From here the close no longer waits for this attempt: whatever its
        // cleanups do afterwards is reported by an event, not by dispose().
        if (running) running.reportsToClose = false
        if (running && running.state === 'running' && !running.rawSettled) {
          running.state = 'abandoned'
          slot.unsettledAttempt = running
          running.endRace?.('abandoned')
        }
        else if (running && running.rawSettled && !slot.unsettledAttempt) {
          // The setup itself has settled; what outlives the grace is its rollback
          // (the cleanups of a failed attempt, or of a result the closing owner
          // discards). It is on the ledger as `rolling-back` until it ends, and
          // the slot is released then.
          this.registerRollingBack(running, slot)
        }
        const attempt = slot.unsettledAttempt ?? running
        if (attempt) this.reportAbandoned(slot, attempt)
        return
      }
      // The sequence settled inside the grace: the attempt settled (its result
      // discarded by this close, or failed) and its cleanups ran. A deadline
      // never settles a sequence, so nothing of it is still running here.
    }
    const attempt = slot.unsettledAttempt
    if (!attempt) return
    const remainingMs = Number.isFinite(graceMs) ? Math.max(0, graceMs - (Date.now() - startedAt)) : graceMs
    if (await settlesWithin(attempt.settled, remainingMs)) return
    slot.state = 'abandoned'
    attempt.reportsToClose = false
    this.reportAbandoned(slot, attempt)
  }

  private reportAbandoned(slot: ServiceSlot, attempt: SetupAttempt): void {
    const record = this.unsettled.get(attempt.id)
    if (record && record.state === 'overdue') record.state = 'abandoned'
    this.reportAbandonment(slot, attempt.rawSettled ? 'rollback' : 'setup', Date.now() - attempt.startedAt)
  }

  /**
   * The one report of a bounded close giving up. The dependency list is
   * materialized here, while the slot is at hand: nothing looks it up later.
   */
  private reportAbandonment(slot: ServiceSlot, phase: 'setup' | 'rollback' | 'cleanup', elapsedMs: number): void {
    this.options.onEvent({
      type: 'attempt-abandoned',
      phase,
      slot: slot.id,
      revision: slot.service.key,
      env: slot.ownerEnvId,
      elapsedMs,
      // The slots it depends on are closed in the normal order regardless (the
      // Runtime cannot revoke an instance it already handed out).
      dependencies: [...slot.requires.entries()]
        .filter((entry): entry is [string, ServiceSlot] => entry[1].kind === 'service')
        .map(([dependency, target]) => ({
          dependency,
          slot: target.id,
          revision: target.service.key,
          state: target.state,
        })),
    })
  }

  /**
   * Dependant-first disposal over the SCC condensation of Ready owned slots.
   * Independent components run concurrently and each dependency chain keeps its
   * order, so the step costs one cleanup budget per slot of the longest chain
   * rather than one per slot. A component whose slot was abandoned counts as
   * finished: its dependencies are disposed regardless (§13).
   */
  async disposeServiceSlots(slotsInput: readonly ServiceSlot[]): Promise<readonly unknown[]> {
    const errors: unknown[] = []
    const disposable = slotsInput.filter(slot => slot.state === 'ready')
    if (disposable.length === 0) return errors
    const adjacency = this.serviceDependencyAdjacency(disposable)
    const scc = stronglyConnectedComponents(adjacency)
    const byId = new Map(disposable.map(slot => [slot.id, slot]))

    // The condensation, as edges rather than as one linear order: `dependencies`
    // are the components a component must outlive, `pendingDependants` how many
    // components must finish before it may close.
    const dependencies = scc.components.map(() => new Set<number>())
    const pendingDependants = scc.components.map(() => 0)
    for (const [source, targets] of adjacency) {
      const from = scc.componentByNode.get(source)!
      for (const target of targets) {
        const to = scc.componentByNode.get(target)!
        if (from === to || dependencies[from]!.has(to)) continue
        dependencies[from]!.add(to)
        pendingDependants[to]! += 1
      }
    }

    const running: Promise<void>[] = []
    const start = (index: number): void => {
      const slots = scc.components[index]!
        .map(id => byId.get(id))
        .filter((slot): slot is ServiceSlot => slot !== undefined)
        .sort((left, right) => (right.completionOrder ?? 0) - (left.completionOrder ?? 0))
      running.push((async () => {
        // Inside a component the order is the reverse of materialization
        // completion, one slot at a time: concurrency is between chains, never
        // along one.
        for (const slot of slots) {
          try { await this.disposeServiceSlot(slot) }
          catch (error) { errors.push(error) }
        }
        for (const dependency of dependencies[index]!) {
          pendingDependants[dependency]! -= 1
          if (pendingDependants[dependency] === 0) start(dependency)
        }
      })())
    }
    for (let index = 0; index < scc.components.length; index += 1) {
      if (pendingDependants[index] === 0) start(index)
    }
    // `running` grows while it is walked: a component started by a finishing one
    // is appended, and every component is started exactly once.
    for (let index = 0; index < running.length; index += 1) await running[index]
    return errors
  }

  // Loading -----------------------------------------------------------------

  private loadService(
    slot: ServiceSlot,
    options: LoadOptions | undefined,
    requester: SetupAttempt | undefined,
  ): Promise<unknown> {
    if (options?.signal?.aborted) {
      // Nothing is started for a caller that already gave up.
      return Promise.reject(new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', {
        slot: slot.id,
        revision: slot.service.key,
      }))
    }
    let value: Promise<unknown>
    try {
      value = this.serviceValue(slot)
    }
    catch (error) {
      value = Promise.reject(error)
    }
    if (slot.state === 'ready') {
      // Nothing to wait for: the caller's own Promise of the instance.
      return waitWithSignal(value.then(instance => instance), options?.signal, () => ({
        slot: slot.id,
        revision: slot.service.key,
      }))
    }
    // Every caller gets its own Promise: a waiter with its own deadline.
    // The shared sequence carries an internal rejection handler so the runtime
    // never produces unhandled rejections on its own; a caller that ignores its
    // Promise sees ordinary JavaScript behaviour (an unhandled rejection)
    // whichever slot state it hit.
    return this.waitFor(slot, value, options?.signal, requester)
  }

  /**
   * One caller's wait on the slot's sequence (or its recovery, or an immediate
   * refusal). The waiter's deadline is armed now if an attempt is running, and
   * by every attempt that starts while the wait lasts; it ends only this wait.
   * An aborted signal ends the wait too (`LOAD_CANCELLED`) and takes the
   * waiter, deadline included, off the slot.
   */
  private waitFor(
    slot: ServiceSlot,
    value: Promise<unknown>,
    signal: AbortSignal | undefined,
    requester: SetupAttempt | undefined,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      // A requester's pending load is observed for the wait-cycle diagnosis
      // exactly as long as this wait lasts (a timeout ends it too).
      const pendingLoad = requester && requester.state === 'running' ? this.nextLoadId++ : undefined
      if (pendingLoad !== undefined) requester!.pendingLoads.set(pendingLoad, { target: slot, since: Date.now() })
      let done = false
      const waiter: SetupWaiter = {
        id: this.nextWaiterId++,
        slot,
        attempt: undefined,
        deadlineMs: 0,
        expiresAt: 0,
        queued: false,
        prev: undefined,
        next: undefined,
        onDeadline: this.onDeadline,
        settle: outcome => {
          if (done) return
          done = true
          slot.waiters.delete(waiter)
          this.disarm(waiter)
          signal?.removeEventListener('abort', onAbort)
          if (pendingLoad !== undefined) requester!.pendingLoads.delete(pendingLoad)
          // Nothing else observes the caller's Promise: ignoring a rejected one
          // is an ordinary unhandled rejection.
          if (outcome.ok) resolve(outcome.value)
          else reject(outcome.error)
        },
      }
      const onAbort = (): void => {
        waiter.settle({
          ok: false,
          error: new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', { slot: slot.id, revision: slot.service.key }),
        })
      }
      slot.waiters.add(waiter)
      value.then(
        instance => waiter.settle({ ok: true, value: instance }),
        error => waiter.settle({ ok: false, error }),
      )
      // A setup may abort its caller's signal while running synchronously inside
      // this very load(): the wait then ends before it is armed.
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const attempt = slot.attempt
      if (attempt && attempt.state === 'running' && !attempt.rawSettled) this.arm(waiter, slot, attempt)
    })
  }

  /** Starts (or restarts) the waiter's deadline for the given running attempt. `Infinity` arms nothing. */
  private arm(waiter: SetupWaiter, slot: ServiceSlot, attempt: SetupAttempt): void {
    const deadlineMs = slot.service.loadTimeoutMs ?? this.options.deadlineMs
    if (!Number.isFinite(deadlineMs)) {
      deadlines.remove(waiter)
      return
    }
    waiter.attempt = attempt
    waiter.deadlineMs = deadlineMs
    deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs))
  }

  private disarm(waiter: SetupWaiter): void {
    deadlines.remove(waiter)
  }

  /**
   * The waiter's deadline passed while its attempt is still running: only this
   * wait ends (`LOAD_TIMEOUT`). The attempt is overdue from the first
   * such timeout on — listed in the ledger as `overdue`, `attempt-overdue`
   * reported once, its slot showing `overdueMs` — and keeps running; its
   * result is adopted if the owner is still ready and discarded only by a
   * close.
   */
  private waiterTimedOut(waiter: SetupWaiter): void {
    const slot = waiter.slot
    const attempt = waiter.attempt
    const deadlineMs = waiter.deadlineMs
    if (!slot.waiters.has(waiter)) return
    if (attempt === undefined || slot.attempt !== attempt || attempt.state !== 'running' || attempt.rawSettled) return
    const owner = this.owner(slot)
    if (attempt.overdueAt === undefined) {
      attempt.overdueAt = Date.now()
      this.registerOverdue(attempt, owner)
      this.options.onEvent({
        type: 'attempt-overdue',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        attemptNumber: attempt.id,
        deadlineMs,
        elapsedMs: attempt.overdueAt - attempt.startedAt,
      })
    }
    waiter.settle({ ok: false, error: this.timeoutError(attempt, slot, owner, deadlineMs) })
  }

  private serviceValue(slot: ServiceSlot): Promise<unknown> {
    switch (slot.state) {
      case 'ready':
        return Promise.resolve(slot.instance)
      case 'disposing':
      case 'disposed':
      case 'abandoned':
        throw new SynaError(
          'SLOT_NOT_LOADABLE',
          `Service slot ${slot.id} (${slot.service.key}) is ${slot.state}.`,
          { slot: slot.id, revision: slot.service.key, state: slot.state },
        )
      case 'failed':
        if (slot.service.failure.afterExhaustion === 'sticky') {
          return Promise.reject(slot.error)
        }
        if (slot.rollbackFailed) return Promise.reject(this.rollbackFailedError(slot))
        return this.recoverFailedSlot(slot)
      case 'dormant':
        this.startSequence(slot)
        return slot.sequence!
      case 'starting':
        return slot.sequence!
    }
  }

  private owner(slot: ServiceSlot): SlotOwnerEnv {
    if (!slot.ownerEnv) {
      throw new Error(`Syna internal invariant: service slot ${slot.id} has no owner Env.`)
    }
    return slot.ownerEnv
  }

  private startSequence(slot: ServiceSlot): void {
    const owner = this.owner(slot)
    this.assertOwnerUsable(owner, slot, 'materialize')
    this.assertNoUnsettledAttempt(slot)
    slot.state = 'starting'
    delete slot.error
    delete slot.failedAt
    // The sequence promise must be observable before setup() runs synchronously:
    // a dependency's setup may call load() back on this slot within the same tick.
    let resolveSequence: (value: unknown) => void = () => undefined
    let rejectSequence: (error: unknown) => void = () => undefined
    const sequence = new Promise<unknown>((resolve, reject) => {
      resolveSequence = resolve
      rejectSequence = reject
    })
    slot.sequence = sequence
    void sequence.catch(() => undefined)
    this.runSequence(slot, owner).then(resolveSequence, rejectSequence)
  }

  /**
   * A failed rollback is final for the slot: whatever the attempt acquired is
   * outside Syna control, so no policy may start an attempt that would stack a
   * second set of resources on top of it. The original failure stays reachable
   * as `cause`.
   */
  private rollbackFailedError(slot: ServiceSlot): SynaError {
    return new SynaError(
      'ROLLBACK_FAILED',
      `Recovery of ${slot.service.key} is refused: the rollback of a previous setup attempt failed, so resources it acquired are not under Syna control and a new attempt would stack on top of them.`,
      { slot: slot.id, revision: slot.service.key, state: slot.state },
      slot.error instanceof Error ? { cause: slot.error } : undefined,
    )
  }

  /**
   * Attempts of one slot never overlap. An unsettled attempt always belongs
   * to an abandoned slot, which refuses `load()` with `SLOT_NOT_LOADABLE`
   * before a sequence could start, so this cannot be reached by a caller.
   */
  private assertNoUnsettledAttempt(slot: ServiceSlot): void {
    const unsettled = slot.unsettledAttempt
    if (!unsettled) return
    throw new Error(`Syna internal invariant: setup attempt ${unsettled.id} of ${slot.service.key} has not settled; a new attempt would overlap it.`)
  }

  private async runSequence(slot: ServiceSlot, owner: SlotOwnerEnv): Promise<unknown> {
    const signal = owner.abortController.signal
    const policy = slot.service.failure
    try {
      for (let index = 1; index <= policy.attempts; index += 1) {
        this.assertOwnerUsable(owner, slot, 'continue setup of')
        const outcome = await this.runAttempt(slot, owner)
        if (outcome.ok) {
          return outcome.instance
        }
        if (outcome.unsettled) throw outcome.error
        if (outcome.cleanupErrors.length > 0) {
          // A failed rollback ends the sequence and is final for the slot: retrying
          // (now or on a later load) on top of leaked resources is not safe.
          slot.rollbackFailed = true
          throw new AggregateError(
            [outcome.error, ...outcome.cleanupErrors],
            `Setup attempt ${index} of ${slot.service.key} and its rollback both failed.`,
            outcome.error instanceof Error ? { cause: outcome.error } : undefined,
          )
        }
        const mayRetry = index < policy.attempts
          && !signal.aborted
          && (owner.state === 'activating' || owner.state === 'ready')
        if (!mayRetry) throw outcome.error
        await sleepAbortable(
          policy.delayMs,
          signal,
          `Retry of ${slot.service.key} was cancelled because owner Env ${owner.id} is closing.`,
          this.closedDetails(owner, slot),
        )
      }
      // `failure.attempts` is a positive integer by definition: the loop above always returns or throws.
      throw new Error(`Syna internal invariant: service ${slot.service.key} exhausted setup attempts.`)
    }
    catch (error) {
      if (slot.state === 'starting') {
        slot.error = error
        slot.failedAt = Date.now()
        slot.state = 'failed'
      }
      delete slot.attempt
      throw error
    }
  }

  private async runAttempt(slot: ServiceSlot, owner: SlotOwnerEnv): Promise<AttemptOutcome> {
    const attempt = this.createAttempt(slot, owner)
    slot.attempt = attempt
    slot.attemptCount += 1

    const dependencyRefs: Record<string, ServiceRef<unknown> | InputRef<unknown>> = {}
    for (const [key, dependencySlot] of slot.requires) {
      dependencyRefs[key] = dependencySlot.kind === 'input'
        ? this.createInputRef(dependencySlot)
        : this.createRef(dependencySlot, attempt)
    }
    const lifecycle = this.createLifecycle(attempt, owner.abortController.signal)

    // The raw Promise lives on the attempt while the attempt runs off the
    // ledger (`releaseRaw` swaps it for a weak handle the moment the attempt is
    // listed) and never in this frame across the await: what only the user's
    // code can settle is not kept alive by a listed attempt.
    const raced = await (() => {
      let rawPromise: Promise<unknown>
      try {
        const raw = slot.service.setup(Object.freeze(dependencyRefs) as never, lifecycle)
        if (isForeignThenable(raw)) {
          this.options.onEvent({
            type: 'setup-returned-thenable',
            slot: slot.id,
            revision: slot.service.key,
            env: owner.id,
          })
        }
        rawPromise = Promise.resolve(raw)
      }
      catch (error) {
        rawPromise = Promise.reject(error)
      }
      attempt.raw = rawPromise
      // Every waiter present now measures its deadline against this attempt.
      for (const waiter of slot.waiters) this.arm(waiter, slot, attempt)
      return raceAttempt(rawPromise, attempt)
    })()
    for (const waiter of slot.waiters) this.disarm(waiter)

    if (raced.kind === 'abandoned') {
      slot.unsettledAttempt = attempt
      const record = this.registerUnsettled(attempt, owner, 'abandoned')
      const error = closedError(
        `Setup of ${slot.service.key} was still pending when owner Env ${owner.id} closed; its eventual result will be discarded.`,
        this.closedDetails(owner, slot)(),
      )
      // The wait-cycle diagnosis only ever reads attempts running under a live
      // owner: an abandoned attempt keeps no dependency slots for it.
      attempt.pendingLoads.clear()
      attempt.endRace = undefined
      const rawPromise = this.releaseRaw(attempt)
      if (rawPromise) this.watchLateSettlement(attempt, rawPromise)
      else {
        // Overdue earlier and collected since: nothing can settle it any more.
        void this.settleRecord(record, attempt, undefined, 'unreachable')
      }
      return { ok: false, error, unsettled: true, cleanupErrors: [] }
    }

    attempt.rawSettled = true
    attempt.raw = undefined
    attempt.endRace = undefined
    if (attempt.watched) this.unreachable.unregister(attempt)
    if (raced.kind === 'unreachable') {
      // The raw Promise of an overdue attempt was collected while its owner
      // lived: the attempt is closed as failed and the sequence goes on with the
      // failure policy (a new attempt cannot overlap one that can never finish).
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot.id)).map(item => item.error)
      attempt.state = 'failed'
      this.attributeToClose(attempt, cleanupErrors)
      this.forgetOverdue(attempt)
      attempt.resolveSettled()
      this.options.onEvent({
        type: 'attempt-unreachable',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        elapsedMs: Date.now() - attempt.startedAt,
        cleanupErrors,
      })
      return {
        ok: false,
        error: new Error(`Setup of ${slot.service.key} can no longer settle: its Promise was garbage-collected while still pending.`),
        unsettled: false,
        cleanupErrors,
      }
    }

    if (raced.kind === 'rejected') {
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot.id)).map(item => item.error)
      attempt.state = 'failed'
      this.attributeToClose(attempt, cleanupErrors)
      // Late is measured from the start of the close, not from its end: a
      // settlement inside the grace is reported like one after it, whether or
      // not a waiter is still there.
      if (this.forgetOverdue(attempt) || this.ownerClosing(owner)) {
        this.options.onEvent({
          type: 'attempt-failed-late',
          slot: slot.id,
          revision: slot.service.key,
          env: owner.id,
          error: raced.error,
          cleanupErrors,
        })
      }
      attempt.resolveSettled()
      return { ok: false, error: raced.error, unsettled: false, cleanupErrors }
    }

    const ownerClosed = owner.abortController.signal.aborted
      || (owner.state !== 'activating' && owner.state !== 'ready')
    if (ownerClosed || slot.attempt !== attempt) {
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot.id)).map(item => item.error)
      attempt.state = 'failed'
      this.attributeToClose(attempt, cleanupErrors)
      if (this.forgetOverdue(attempt) || ownerClosed) {
        this.options.onEvent({
          type: 'attempt-succeeded-late',
          slot: slot.id,
          revision: slot.service.key,
          env: owner.id,
          adopted: false,
          cleanupErrors,
        })
      }
      attempt.resolveSettled()
      return {
        ok: false,
        error: closedError(
          `Setup of ${slot.service.key} completed after owner Env ${owner.id} began closing; the instance was discarded.`,
          this.closedDetails(owner, slot)(),
        ),
        unsettled: false,
        cleanupErrors,
      }
    }

    attempt.state = 'succeeded'
    attempt.resolveSettled()
    slot.instance = raced.value
    slot.instanceAttemptId = attempt.id
    slot.cleanups = attempt.cleanups
    slot.completionOrder = this.completionCounter++
    slot.state = 'ready'
    delete slot.attempt
    delete slot.error
    delete slot.failedAt
    if (this.forgetOverdue(attempt)) {
      // Adopted: the owner is still ready, so the late instance is the slot's
      // and its cleanups run at disposal like any other. Only a close discards
      // a late success.
      this.options.onEvent({
        type: 'attempt-succeeded-late',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        adopted: true,
        cleanupErrors: [],
      })
    }
    return { ok: true, instance: raced.value }
  }

  private createAttempt(slot: ServiceSlot, owner: SlotOwnerEnv): SetupAttempt {
    return new Attempt(this.nextAttemptId++, slot, owner.attemptOwner)
  }

  /**
   * The lifecycle handed to one `setup()`. Built here rather than inside
   * `runAttempt` so that the object the user's own frame keeps — for as long as
   * that setup is pending — reaches the attempt and two strings, never the slot
   * and never the Env behind it.
   */
  private createLifecycle(attempt: SetupAttempt, signal: AbortSignal): ServiceLifecycle {
    return {
      signal,
      onDispose: cleanup => {
        if (typeof cleanup !== 'function') {
          throw new TypeError('onDispose() expects a cleanup function.')
        }
        // Accepted for as long as this attempt's setup is still executing, which
        // includes the time after its deadline passed or its owner closed: the
        // resource acquired late is exactly the one the late-settlement cleanup
        // must release. Refused once the raw Promise settled (stale lifecycle).
        if (attempt.rawSettled || attempt.state === 'succeeded' || attempt.state === 'failed') {
          throw new SynaError(
            'LIFECYCLE_MISUSE',
            `onDispose() for ${attempt.revisionKey} may only be called while its setup attempt is still executing.`,
            { slot: attempt.slotId, revision: attempt.revisionKey, attemptNumber: attempt.id, state: attempt.state },
          )
        }
        attempt.cleanups.push(cleanup)
      },
    }
  }

  /** The slot of an attempt: strong while it runs off the ledger, weak once it is listed, gone once its Env was collected. */
  private slotOf(attempt: SetupAttempt): ServiceSlot | undefined {
    return attempt.slot ?? attempt.slotRef?.deref()
  }

  /**
   * Leaves a listed attempt with a weak handle on its slot (created here, on
   * this rare path, never per attempt), so that from now on nothing the Runtime
   * holds keeps the owner Env's graph alive.
   */
  private releaseSlot(attempt: SetupAttempt): void {
    const slot = attempt.slot
    if (!slot) return
    attempt.slotRef = new WeakRef(slot)
    attempt.slot = undefined
  }

  /**
   * Watches the raw Promise of an abandoned attempt for its late settlement.
   * A method of its own, so the reactions the pending Promise keeps close over
   * the attempt and an id string — never over `runAttempt`'s scope, which holds
   * the slot, the owner Env and the dependency refs.
   */
  private watchLateSettlement(attempt: SetupAttempt, rawPromise: Promise<unknown>): void {
    const envId = attempt.owner.envId
    this.watch(attempt, rawPromise)
    rawPromise.then(
      () => this.handleLateSettlement(attempt, envId, undefined),
      lateError => this.handleLateSettlement(attempt, envId, { error: lateError }),
    )
  }

  /** Whether the owner's close has begun: from then on its attempts' cleanup failures are the close's to report. */
  private ownerClosing(owner: SlotOwnerEnv): boolean {
    return owner.abortController.signal.aborted || (owner.state !== 'activating' && owner.state !== 'ready')
  }

  /**
   * A cleanup failure of an attempt whose owner is closing belongs to that
   * close: it enters `dispose()`'s AggregateError exactly once, whether or not a
   * waiter is still there to see the rejection of its own `load()`. Failures of
   * an attempt the close stopped waiting for are reported by an event instead.
   */
  private attributeToClose(attempt: SetupAttempt, cleanupErrors: readonly unknown[]): void {
    if (cleanupErrors.length === 0 || !attempt.reportsToClose || !attempt.owner.closing) return
    attempt.owner.closeErrors.push(new AggregateError(
      [...cleanupErrors],
      `Rollback of ${attempt.revisionKey} failed while owner Env ${attempt.owner.envId} was closing.`,
    ))
  }

  /**
   * The attempt's first waiter timed out: it is overdue, listed as `overdue`
   * while it keeps running under its live owner. From now on it holds the raw
   * Promise only weakly, so that Promise's reachability bounds the record.
   */
  private registerOverdue(attempt: SetupAttempt, owner: SlotOwnerEnv): void {
    this.registerUnsettled(attempt, owner, 'overdue')
    const rawPromise = this.releaseRaw(attempt)
    if (rawPromise) this.watch(attempt, rawPromise)
    else attempt.endRace?.('unreachable')
  }

  /**
   * Hands out the raw Promise of an attempt that is being listed and leaves the
   * attempt with a weak handle only (created here, on this rare path, never per
   * attempt). Undefined when the attempt was listed before and the Promise has
   * been collected since.
   */
  private releaseRaw(attempt: SetupAttempt): Promise<unknown> | undefined {
    const rawPromise = attempt.raw
    if (rawPromise) {
      attempt.rawRef = new WeakRef(rawPromise)
      attempt.raw = undefined
      return rawPromise
    }
    return attempt.rawRef?.deref()
  }

  /** Drops the ledger entry of an overdue attempt once it settled; tells whether the attempt was overdue. */
  private forgetOverdue(attempt: SetupAttempt): boolean {
    if (attempt.overdueAt === undefined) return false
    const record = this.unsettled.get(attempt.id)
    if (record && record.attempt === attempt) this.unsettled.delete(attempt.id)
    return true
  }

  private registerUnsettled(
    attempt: SetupAttempt,
    owner: SlotOwnerEnv,
    state: 'overdue' | 'abandoned',
  ): UnsettledRecord {
    const existing = this.unsettled.get(attempt.id)
    if (existing && existing.attempt === attempt) {
      existing.state = state
      return existing
    }
    const record: UnsettledRecord = {
      id: attempt.id,
      attempt,
      slot: attempt.slotId,
      revision: attempt.revisionKey,
      env: owner.id,
      startedAt: attempt.startedAt,
      state,
    }
    this.unsettled.set(attempt.id, record)
    this.releaseSlot(attempt)
    return record
  }

  /**
   * Registers the raw Promise for the unreachable diagnosis, once per attempt.
   * The held value keeps the attempt reachable until the raw Promise is
   * collected; the attempt holds that Promise only weakly, so this never delays
   * its collection.
   */
  private watch(attempt: SetupAttempt, rawPromise: Promise<unknown>): void {
    if (attempt.watched) return
    attempt.watched = true
    this.unreachable.register(rawPromise, { id: attempt.id, attempt }, attempt)
  }

  /** A failed or discarded attempt whose rollback outlived the disposal grace: listed until the rollback ends. */
  private registerRollingBack(attempt: SetupAttempt, slot: ServiceSlot): void {
    const record: UnsettledRecord = {
      id: attempt.id,
      attempt,
      slot: slot.id,
      revision: slot.service.key,
      env: slot.ownerEnvId,
      startedAt: attempt.startedAt,
      state: 'rolling-back',
    }
    this.unsettled.set(attempt.id, record)
    this.releaseSlot(attempt)
    // The reaction is kept by the attempt's own `settled` Promise: it closes over
    // the record and the attempt, and reaches the slot only weakly.
    void attempt.settled.then(() => {
      if (this.unsettled.get(record.id) === record) this.unsettled.delete(record.id)
      const settled = this.slotOf(attempt)
      if (settled && settled.state === 'abandoned') settled.state = 'disposed'
    })
  }

  /** Runs the late close of a ledgered attempt; the record stays listed (as `settling`) until the cleanups are done. */
  private settleRecord(
    record: UnsettledRecord,
    attempt: SetupAttempt,
    failure: { readonly error: unknown } | undefined,
    how: 'settled' | 'unreachable',
  ): Promise<void> {
    record.state = 'settling'
    record.closing = this.closeUnsettled(attempt, record.env, failure, how).finally(() => {
      if (this.unsettled.get(record.id) === record) this.unsettled.delete(record.id)
    })
    return record.closing
  }

  private attemptUnreachable({ id, attempt }: UnreachableToken): void {
    const record = this.unsettled.get(id)
    if (!record || record.attempt !== attempt) return
    if (attempt.rawSettled) {
      this.unsettled.delete(id)
      return
    }
    if (attempt.state === 'running') {
      // Overdue under a live owner: the attempt is still racing; the race ends
      // as `unreachable` and the sequence takes the failure path.
      attempt.endRace?.('unreachable')
      return
    }
    void this.settleRecord(record, attempt, undefined, 'unreachable')
  }

  private async handleLateSettlement(
    attempt: SetupAttempt,
    envId: string,
    failure: { readonly error: unknown } | undefined,
  ): Promise<void> {
    this.unreachable.unregister(attempt)
    const record = this.unsettled.get(attempt.id)
    if (record && record.attempt === attempt && record.closing === undefined) {
      await this.settleRecord(record, attempt, failure, 'settled')
      return
    }
    await this.closeUnsettled(attempt, envId, failure, 'settled')
  }

  /**
   * Ends an unsettled attempt: its late result (if any) is discarded, the
   * cleanups it registered run, its slot is released, and the outcome is
   * reported. `unreachable` means the raw Promise was collected unsettled.
   */
  private async closeUnsettled(
    attempt: SetupAttempt,
    envId: string,
    failure: { readonly error: unknown } | undefined,
    how: 'settled' | 'unreachable',
  ): Promise<void> {
    attempt.rawSettled = true
    // The slot may be gone with its Env: the cleanups of the attempt run either
    // way, and what is reported comes from the attempt's own record of itself.
    const slot = this.slotOf(attempt)
    const cleanupErrors = (await this.runCleanups(attempt.cleanups, attempt.slotId)).map(item => item.error)
    this.attributeToClose(attempt, cleanupErrors)
    if (slot) {
      if (slot.unsettledAttempt === attempt) delete slot.unsettledAttempt
      // Resources a late cleanup could not release are outside Syna control from now on.
      if (cleanupErrors.length > 0) slot.rollbackFailed = true
      // An abandoned slot has now released everything its attempt acquired.
      if (slot.state === 'abandoned' && slot.unsettledAttempt === undefined) slot.state = 'disposed'
    }
    attempt.resolveSettled()
    if (how === 'unreachable') {
      this.options.onEvent({
        type: 'attempt-unreachable',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        elapsedMs: Date.now() - attempt.startedAt,
        cleanupErrors,
      })
      return
    }
    if (failure) {
      this.options.onEvent({
        type: 'attempt-failed-late',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        error: failure.error,
        cleanupErrors,
      })
    }
    else {
      this.options.onEvent({
        type: 'attempt-succeeded-late',
        slot: attempt.slotId,
        revision: attempt.revisionKey,
        env: envId,
        adopted: false,
        cleanupErrors,
      })
    }
  }

  private timeoutError(attempt: SetupAttempt, slot: ServiceSlot, owner: SlotOwnerEnv, deadlineMs: number): SynaError {
    const now = Date.now()
    const pendingLoads = [...attempt.pendingLoads.values()].map(pending => ({
      revision: pending.target.service.key,
      slot: pending.target.id,
      state: pending.target.state,
      waitingMs: now - pending.since,
    }))
    const suspectedWaitCycle = this.findSuspectedWaitCycle(slot)
    return new SynaError(
      'LOAD_TIMEOUT',
      `Setup of ${slot.service.key} did not complete within ${deadlineMs} ms.${
        suspectedWaitCycle
          ? ` Observed load() calls form a cycle (${suspectedWaitCycle.join(' -> ')}); this is an observation, not a proof of deadlock.`
          : ''
      }`,
      {
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        attemptNumber: attempt.id,
        deadlineMs,
        elapsedMs: now - attempt.startedAt,
        pendingLoads,
        ...(suspectedWaitCycle ? { suspectedWaitCycle } : {}),
        attemptStillRunning: true,
        note: 'The deadline ended this wait while setup was still pending. The attempt keeps running; its result is adopted if the owner Env is still ready, and discarded only if the owner closes.',
      },
    )
  }

  /** Follows pending load() calls between starting slots. Returns revision keys when they lead back to `origin`. */
  private findSuspectedWaitCycle(origin: ServiceSlot): readonly string[] | undefined {
    const path: string[] = []
    const visited = new Set<string>()
    const visit = (slot: ServiceSlot): boolean => {
      if (visited.has(slot.id)) return false
      visited.add(slot.id)
      path.push(slot.service.key)
      const attempt = slot.attempt
      if (attempt) {
        for (const pending of attempt.pendingLoads.values()) {
          if (pending.target === origin) {
            path.push(origin.service.key)
            return true
          }
          if (pending.target.state === 'starting' && visit(pending.target)) return true
        }
      }
      path.pop()
      return false
    }
    return visit(origin) ? path : undefined
  }

  private recoverFailedSlot(slot: ServiceSlot): Promise<unknown> {
    if (slot.recovery) return slot.recovery
    const owner = this.owner(slot)
    this.assertNoUnsettledAttempt(slot)

    const recovery = (async () => {
      this.assertOwnerUsable(owner, slot, 'recover')
      const elapsed = Date.now() - (slot.failedAt ?? 0)
      const remaining = Math.max(0, slot.service.failure.cooldownMs - elapsed)
      await sleepAbortable(
        remaining,
        owner.abortController.signal,
        `Recovery of ${slot.service.key} was cancelled because owner Env ${owner.id} is closing.`,
        this.closedDetails(owner, slot),
      )
      this.assertOwnerUsable(owner, slot, 'recover')
      // A late cleanup may have failed during the cooldown: the slot is then final.
      if (slot.rollbackFailed) throw this.rollbackFailedError(slot)
      if (slot.state === 'ready') return slot.instance
      if (slot.state === 'starting' && slot.sequence) return slot.sequence
      if (slot.state !== 'failed') {
        // The owner was just found usable and recovery is single-flight: the slot is `failed` here.
        throw new Error(`Syna internal invariant: cannot recover ${slot.service.key} from state ${slot.state}.`)
      }
      slot.state = 'dormant'
      this.startSequence(slot)
      return slot.sequence!
    })()
    slot.recovery = recovery
    void recovery.then(
      () => { if (slot.recovery === recovery) delete slot.recovery },
      () => { if (slot.recovery === recovery) delete slot.recovery },
    )
    return recovery
  }

  private assertOwnerUsable(owner: SlotOwnerEnv, slot: ServiceSlot, action: string): void {
    const closing = owner.abortController.signal.aborted
    if (!closing && (owner.state === 'activating' || owner.state === 'ready')) return
    throw closedError(
      closing
        ? `Cannot ${action} ${slot.service.key}: owner Env ${owner.id} is closing.`
        : `Cannot ${action} ${slot.service.key} while owner Env ${owner.id} is ${owner.state}.`,
      this.closedDetails(owner, slot)(),
    )
  }

  /** The `ENV_CLOSED` details of a slot-level refusal, read when the refusal is built. */
  private closedDetails(owner: SlotOwnerEnv, slot: ServiceSlot): () => ClosedEnvDetails {
    return () => ({ env: owner.id, state: owner.state, slot: slot.id, revision: slot.service.key })
  }

  // Disposal ------------------------------------------------------------------

  private serviceDependencyAdjacency(
    slots: readonly ServiceSlot[],
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const included = new Set(slots.map(slot => slot.id))
    const adjacency = new Map<string, Set<string>>()
    // A dependency that passes through a Service slot outside the disposable set
    // (dormant, failed, owned elsewhere) still orders the slots on either side:
    // A -> B -> C with B never started must dispose A before C.
    const collect = (
      slot: RuntimeSlot,
      visited: Set<string>,
      output: Set<string>,
    ): void => {
      if (visited.has(slot.id)) return
      visited.add(slot.id)
      if (slot.kind === 'service' && included.has(slot.id)) {
        output.add(slot.id)
        return
      }
      for (const dependency of slot.requires.values()) collect(dependency, visited, output)
    }
    for (const slot of slots) {
      const targets = new Set<string>()
      for (const dependency of slot.requires.values()) collect(dependency, new Set(), targets)
      adjacency.set(slot.id, targets)
    }
    return adjacency
  }

  /**
   * One Ready slot's cleanup phase, bounded by `limits.disposalGraceMs`. What
   * does not end inside that budget is abandoned: the close stops waiting, the
   * cleanup keeps running (nothing can terminate it), and the slot is listed and
   * reported. `dispose()` does not reject for an abandoned cleanup — only for
   * one that threw while the close was still waiting for it.
   */
  private async disposeServiceSlot(slot: ServiceSlot): Promise<void> {
    if (slot.state !== 'ready') return
    slot.state = 'disposing'
    if (slot.cleanups.length === 0) {
      // A slot that registered no cleanup has nothing that could outlive the
      // budget, so there is nothing to bound: the timer the grace needs is not
      // armed at all. Most slots are this one.
      slot.state = 'disposed'
      delete slot.instance
      return
    }
    const startedAt = Date.now()
    const running = this.runCleanups(slot.cleanups, slot.id)
    if (!(await settlesWithin(running, this.options.disposalGraceMs))) {
      this.abandonCleanup(slot, running, startedAt)
      return
    }
    const errors = await running
    slot.state = 'disposed'
    delete slot.instance
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map(item => item.error),
        `Service ${slot.service.key} failed to dispose cleanly.`,
      )
    }
  }

  /**
   * The close stops waiting for a cleanup phase: the slot is listed as
   * `abandoned` under the attempt that produced the instance, reported with
   * `phase: 'cleanup'`, and its dependencies are disposed regardless. When the
   * cleanup ends late the entry is dropped, and a failure is reported by
   * `attempt-failed-late` — never by the `dispose()` that stopped waiting for it.
   */
  private abandonCleanup(
    slot: ServiceSlot,
    running: Promise<readonly DisposableError[]>,
    startedAt: number,
  ): void {
    slot.state = 'abandoned'
    delete slot.instance
    const id = slot.instanceAttemptId ?? this.nextAttemptId++
    const slotId = slot.id
    const revisionKey = slot.service.key
    const envId = slot.ownerEnvId
    const record: UnsettledRecord = {
      id,
      attempt: undefined,
      slot: slotId,
      revision: revisionKey,
      env: envId,
      startedAt,
      state: 'abandoned',
    }
    this.unsettled.set(id, record)
    this.reportAbandonment(slot, 'cleanup', Date.now() - startedAt)
    // The reaction is kept by the cleanup that outlived the close: like a listed
    // attempt, it reaches its slot only weakly.
    const slotRef = new WeakRef(slot)
    record.closing = running.then(errors => {
      if (this.unsettled.get(id) === record) this.unsettled.delete(id)
      const abandoned = slotRef.deref()
      if (abandoned && abandoned.state === 'abandoned') abandoned.state = 'disposed'
      if (errors.length === 0) return
      this.options.onEvent({
        type: 'attempt-failed-late',
        slot: slotId,
        revision: revisionKey,
        env: envId,
        error: errors.length === 1
          ? errors[0]!.error
          : new AggregateError(errors.map(item => item.error), `Service ${revisionKey} failed to dispose cleanly.`),
        cleanupErrors: errors.map(item => item.error),
      })
    })
  }

  /** Runs cleanups in reverse registration order; every cleanup runs even if an earlier one throws. */
  private async runCleanups(
    cleanups: Array<() => Awaitable<void>>,
    slotId: string,
  ): Promise<readonly DisposableError[]> {
    const errors: DisposableError[] = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() }
      catch (error) { errors.push({ slot: slotId, error }) }
    }
    return errors
  }
}

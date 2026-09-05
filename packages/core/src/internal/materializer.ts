import type {
  Awaitable,
  DependencyRef,
  InputRef,
  LoadOptions,
  RuntimeEvent,
  ServiceLifecycle,
  UnsettledAttemptInspection,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import {
  dependantFirstComponentOrder,
  stronglyConnectedComponents,
} from '../graph.js'
import type {
  DisposableError,
  EnvState,
  InputSlot,
  RuntimeSlot,
  ServiceSlot,
  SetupAttempt,
  SlotOwnerEnv,
} from './runtime-model.js'
import {
  abortError,
  assertNotAborted,
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
      /** The raw setup Promise is still pending (deadline or disposal ended the wait); never retried. */
      readonly unsettled: boolean
      readonly cleanupErrors: readonly unknown[]
    }

type RaceResult =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'abandoned' }

/** A slot whose setup attempt was still pending when its owner Env closed. */
export interface AbandonedAttempt {
  readonly slot: ServiceSlot
  readonly attempt: SetupAttempt
}

/**
 * Ledger entry for an attempt whose raw Promise is still pending after its
 * deadline or its owner's close. It holds the attempt weakly on purpose: the
 * only strong path to an unsettled attempt is the user's own pending Promise
 * (its reaction holds the attempt, which holds its slot and owner Env), so
 * retention ends exactly when that Promise settles or becomes unreachable.
 */
interface UnsettledRecord {
  readonly id: number
  readonly attempt: WeakRef<SetupAttempt>
  readonly slot: string
  readonly revision: string
  readonly env: string
  readonly startedAt: number
  state: 'timed-out' | 'abandoned'
}

function isForeignThenable(value: unknown): boolean {
  if (value instanceof Promise) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Settles with the raw result, with `timeout` when the deadline passes first,
 * or with `abandoned` when disposal stops waiting first. Whichever comes first
 * wins; the raw Promise itself is never cancelled.
 */
function raceDeadline(
  promise: Promise<unknown>,
  deadlineMs: number,
  abandoned: Promise<void>,
): Promise<RaceResult> {
  const settled = promise.then(
    (value): RaceResult => ({ kind: 'resolved', value }),
    (error): RaceResult => ({ kind: 'rejected', error }),
  )
  return new Promise<RaceResult>(resolve => {
    const timer = Number.isFinite(deadlineMs)
      ? setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, deadlineMs))
      : undefined
    const finish = (result: RaceResult): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    void settled.then(finish)
    void abandoned.then(() => finish({ kind: 'abandoned' }))
  })
}

/**
 * Owns every operational concern of Service slots: attempts, waiters, retry,
 * recovery, deadlines and cleanup ordering. Topology is decided elsewhere; the
 * materializer can only realize already-created slots.
 *
 * `load()` returns a plain Promise for the slot's current setup sequence. No
 * completion barrier is attached to the caller; whether the caller awaits the
 * Promise is ordinary JavaScript.
 */
export class Materializer {
  private nextAttemptId = 1
  private nextLoadId = 1
  private completionCounter = 1
  private readonly unsettled = new Map<number, UnsettledRecord>()
  /**
   * Fires when the raw setup Promise of an unsettled attempt is garbage-
   * collected: nothing can settle it any more, so the attempt is closed as
   * failed (its registered cleanups run) instead of staying pending forever.
   */
  private readonly unreachable = new FinalizationRegistry<number>(id => this.attemptUnreachable(id))

  constructor(private readonly options: MaterializerOptions) {}

  /** Every attempt the Runtime is still waiting on, oldest first. Entries whose attempt was collected are dropped. */
  unsettledAttempts(): readonly UnsettledAttemptInspection[] {
    const now = Date.now()
    const views: UnsettledAttemptInspection[] = []
    for (const record of this.unsettled.values()) {
      const attempt = record.attempt.deref()
      if (!attempt || attempt.rawSettled) {
        this.unsettled.delete(record.id)
        continue
      }
      views.push(Object.freeze({
        attempt: record.id,
        slot: record.slot,
        revision: record.revision,
        env: record.env,
        state: record.state,
        runningForMs: now - record.startedAt,
      }))
    }
    return Object.freeze(views)
  }

  createRef<T>(slot: RuntimeSlot, requester?: SetupAttempt): DependencyRef<T> {
    return Object.freeze({
      load: (options?: LoadOptions) => this.load(slot, options, requester) as Promise<T>,
      preload: () => { void this.load(slot, undefined, undefined).catch(() => undefined) },
    })
  }

  createInputRef<T>(slot: InputSlot): InputRef<T> {
    return Object.freeze({
      read: () => slot.payload as T,
      load: () => Promise.resolve(slot.payload as Awaited<T>),
    })
  }

  load(slot: RuntimeSlot, options?: LoadOptions, requester?: SetupAttempt): Promise<unknown> {
    if (options !== undefined && (typeof options !== 'object' || options === null)) {
      return Promise.reject(new TypeError('load() options must be an object.'))
    }
    switch (slot.kind) {
      case 'input': return Promise.resolve(slot.payload)
      case 'binding': return this.load(slot.requires.get('target')!, options, requester)
      case 'selector':
      case 'all':
      case 'entry': return Promise.resolve(slot.value)
      case 'service': return this.loadService(slot, options, requester)
    }
  }

  /** Starts every given eager slot and resolves when all are Ready; rejects with the first failure. */
  async startEagerSlots(slots: readonly ServiceSlot[]): Promise<void> {
    await Promise.all(slots.map(slot => this.loadService(slot, undefined, undefined)))
  }

  /**
   * Gives every in-flight attempt of the given slots at most `disposal.graceMs`
   * to settle after the owner's stop signal: running sequences as well as
   * attempts whose deadline already passed. Slots are waited for concurrently,
   * so the whole step is bounded by one grace period regardless of the
   * per-service `setupDeadlineMs` (even `Infinity`). Attempts that do not
   * settle in time are abandoned: their slot is marked `abandoned`, the attempt
   * stays registered as `unsettledAttempt`, and its late result is still
   * discarded, cleaned up and reported when it eventually arrives.
   */
  async settleSlots(slots: readonly ServiceSlot[]): Promise<readonly AbandonedAttempt[]> {
    const outcomes = await Promise.all(slots.map(slot => this.settleSlot(slot)))
    return outcomes.filter((item): item is AbandonedAttempt => item !== undefined)
  }

  private async settleSlot(slot: ServiceSlot): Promise<AbandonedAttempt | undefined> {
    const graceMs = this.options.disposalGraceMs
    const startedAt = Date.now()
    if (slot.state === 'starting' && slot.sequence) {
      if (!(await settlesWithin(slot.sequence, graceMs))) {
        const running = slot.attempt
        slot.state = 'abandoned'
        if (running && running.state === 'running') {
          running.state = 'abandoned'
          slot.unsettledAttempt = running
          running.abandon()
        }
        const attempt = slot.unsettledAttempt ?? running
        if (!attempt) return undefined
        this.reportAbandoned(slot, attempt)
        return { slot, attempt }
      }
      // The sequence settled inside the grace, possibly by its own deadline: the
      // raw setup is then still running as `unsettledAttempt` and gets the rest
      // of the same grace below instead of vanishing from the close report.
    }
    const attempt = slot.unsettledAttempt
    if (!attempt) return undefined
    const remainingMs = Number.isFinite(graceMs) ? Math.max(0, graceMs - (Date.now() - startedAt)) : graceMs
    if (await settlesWithin(attempt.settled, remainingMs)) return undefined
    slot.state = 'abandoned'
    this.reportAbandoned(slot, attempt)
    return { slot, attempt }
  }

  private reportAbandoned(slot: ServiceSlot, attempt: SetupAttempt): void {
    const record = this.unsettled.get(attempt.id)
    if (record) record.state = 'abandoned'
    this.options.onEvent({
      type: 'attempt-abandoned',
      slot: slot.id,
      revision: slot.service.key,
      env: slot.ownerEnvId,
      elapsedMs: Date.now() - attempt.startedAt,
    })
  }

  /** Dependant-first disposal over the SCC condensation of Ready owned slots. */
  async disposeServiceSlots(slotsInput: readonly ServiceSlot[]): Promise<readonly unknown[]> {
    const errors: unknown[] = []
    const disposable = slotsInput.filter(slot => slot.state === 'ready')
    const adjacency = this.serviceDependencyAdjacency(disposable)
    const scc = stronglyConnectedComponents(adjacency)
    const componentOrder = dependantFirstComponentOrder(adjacency, scc)
    const byId = new Map(disposable.map(slot => [slot.id, slot]))

    for (const componentIndex of componentOrder) {
      const slots = scc.components[componentIndex]!
        .map(id => byId.get(id))
        .filter((slot): slot is ServiceSlot => slot !== undefined)
        .sort((left, right) => (right.completionOrder ?? 0) - (left.completionOrder ?? 0))
      for (const slot of slots) {
        try { await this.disposeServiceSlot(slot) }
        catch (error) { errors.push(error) }
      }
    }
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
    if (requester && requester.state === 'running' && slot.state !== 'ready') {
      const loadId = this.nextLoadId++
      requester.pendingLoads.set(loadId, { target: slot, since: Date.now() })
      value.then(
        () => requester.pendingLoads.delete(loadId),
        () => requester.pendingLoads.delete(loadId),
      )
    }
    // Every caller gets its own Promise. The shared sequence carries an internal
    // rejection handler so the runtime never produces unhandled rejections on
    // its own; a caller that ignores its Promise sees ordinary JavaScript
    // behaviour (an unhandled rejection) whichever slot state it hit.
    const own = value.then(instance => instance)
    return waitWithSignal(own, options?.signal, () => ({
      slot: slot.id,
      revision: slot.service.key,
    }))
  }

  private serviceValue(slot: ServiceSlot): Promise<unknown> {
    switch (slot.state) {
      case 'ready':
        return Promise.resolve(slot.instance)
      case 'disposing':
      case 'disposed':
      case 'abandoned':
        throw new SynaError(
          'INVALID_ENV_STATE',
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
      throw new SynaError('INVALID_ENV_STATE', `Service slot ${slot.id} has no owner Env.`, { slot: slot.id })
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

  private assertNoUnsettledAttempt(slot: ServiceSlot): void {
    const unsettled = slot.unsettledAttempt
    if (!unsettled) return
    throw new SynaError(
      'UNSETTLED_ATTEMPT',
      `A previous setup attempt of ${slot.service.key} timed out but is still running; a new attempt would overlap it.`,
      {
        slot: slot.id,
        revision: slot.service.key,
        attempt: unsettled.id,
        runningForMs: Date.now() - unsettled.startedAt,
      },
    )
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
        )
      }
      throw new SynaError('INVALID_ENV_STATE', `Service ${slot.service.key} exhausted setup attempts.`)
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
    const attempt = this.createAttempt(slot)
    slot.attempt = attempt
    slot.attemptCount += 1

    const dependencyRefs: Record<string, DependencyRef<unknown> | InputRef<unknown>> = {}
    for (const [key, dependencySlot] of slot.requires) {
      dependencyRefs[key] = dependencySlot.kind === 'input'
        ? this.createInputRef(dependencySlot)
        : this.createRef(dependencySlot, attempt)
    }
    const lifecycle: ServiceLifecycle = {
      signal: owner.abortController.signal,
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
            'INVALID_ENV_STATE',
            `onDispose() for ${slot.service.key} may only be called while its setup attempt is still executing.`,
            { slot: slot.id, revision: slot.service.key, attempt: attempt.id, state: attempt.state },
          )
        }
        attempt.cleanups.push(cleanup)
      },
    }

    let rawPromise: Promise<unknown>
    try {
      const raw = slot.service.setup(Object.freeze(dependencyRefs) as never, lifecycle)
      if (isForeignThenable(raw)) {
        this.options.onEvent({
          type: 'foreign-thenable-setup',
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
    void rawPromise.catch(() => undefined)

    const deadlineMs = slot.service.setupDeadlineMs ?? this.options.deadlineMs
    const raced = await raceDeadline(rawPromise, deadlineMs, attempt.abandoned)

    if (raced.kind === 'timeout' || raced.kind === 'abandoned') {
      if (raced.kind === 'timeout') attempt.state = 'timed-out'
      slot.unsettledAttempt = attempt
      this.registerUnsettled(attempt, rawPromise, owner, raced.kind === 'timeout' ? 'timed-out' : 'abandoned')
      const error = raced.kind === 'timeout'
        ? this.timeoutError(attempt, owner, deadlineMs)
        : abortError(
          `Setup of ${slot.service.key} was still pending when owner Env ${owner.id} closed; its eventual result will be discarded.`,
          { slot: slot.id, revision: slot.service.key, env: owner.id, attempt: attempt.id },
        )
      rawPromise.then(
        () => this.handleLateSettlement(attempt, owner, undefined),
        lateError => this.handleLateSettlement(attempt, owner, { error: lateError }),
      )
      return { ok: false, error, unsettled: true, cleanupErrors: [] }
    }

    attempt.rawSettled = true
    if (raced.kind === 'rejected') {
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot)).map(item => item.error)
      attempt.state = 'failed'
      attempt.resolveSettled()
      return { ok: false, error: raced.error, unsettled: false, cleanupErrors }
    }

    const ownerClosed = owner.abortController.signal.aborted
      || (owner.state !== 'activating' && owner.state !== 'ready')
    if (ownerClosed || slot.attempt !== attempt) {
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot)).map(item => item.error)
      attempt.state = 'failed'
      attempt.resolveSettled()
      return {
        ok: false,
        error: abortError(
          `Setup of ${slot.service.key} completed after owner Env ${owner.id} began closing; the instance was discarded.`,
          { slot: slot.id, revision: slot.service.key, env: owner.id },
        ),
        unsettled: false,
        cleanupErrors,
      }
    }

    attempt.state = 'succeeded'
    attempt.resolveSettled()
    slot.instance = raced.value
    slot.cleanups = attempt.cleanups
    slot.completionOrder = this.completionCounter++
    slot.state = 'ready'
    delete slot.attempt
    delete slot.error
    delete slot.failedAt
    return { ok: true, instance: raced.value }
  }

  private createAttempt(slot: ServiceSlot): SetupAttempt {
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>(resolve => { resolveSettled = resolve })
    let abandon: () => void = () => undefined
    const abandoned = new Promise<void>(resolve => { abandon = resolve })
    return {
      id: this.nextAttemptId++,
      slot,
      startedAt: Date.now(),
      state: 'running',
      cleanups: [],
      pendingLoads: new Map(),
      rawSettled: false,
      settled,
      resolveSettled,
      abandoned,
      abandon,
    }
  }

  private registerUnsettled(
    attempt: SetupAttempt,
    rawPromise: Promise<unknown>,
    owner: SlotOwnerEnv,
    state: 'timed-out' | 'abandoned',
  ): void {
    this.unsettled.set(attempt.id, {
      id: attempt.id,
      attempt: new WeakRef(attempt),
      slot: attempt.slot.id,
      revision: attempt.slot.service.key,
      env: owner.id,
      startedAt: attempt.startedAt,
      state,
    })
    this.unreachable.register(rawPromise, attempt.id, attempt)
  }

  private attemptUnreachable(id: number): void {
    const record = this.unsettled.get(id)
    if (!record) return
    this.unsettled.delete(id)
    const attempt = record.attempt.deref()
    if (!attempt || attempt.rawSettled) return
    void this.closeUnsettled(attempt, record.env, undefined, 'unreachable')
  }

  private async handleLateSettlement(
    attempt: SetupAttempt,
    owner: SlotOwnerEnv,
    failure: { readonly error: unknown } | undefined,
  ): Promise<void> {
    this.unsettled.delete(attempt.id)
    this.unreachable.unregister(attempt)
    await this.closeUnsettled(attempt, owner.id, failure, 'settled')
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
    const slot = attempt.slot
    const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot)).map(item => item.error)
    if (slot.unsettledAttempt === attempt) delete slot.unsettledAttempt
    // Resources a late cleanup could not release are outside Syna control from now on.
    if (cleanupErrors.length > 0) slot.rollbackFailed = true
    // An abandoned slot has now released everything its attempt acquired.
    if (slot.state === 'abandoned' && slot.unsettledAttempt === undefined) slot.state = 'disposed'
    attempt.resolveSettled()
    if (how === 'unreachable') {
      this.options.onEvent({
        type: 'attempt-unreachable',
        slot: slot.id,
        revision: slot.service.key,
        env: envId,
        elapsedMs: Date.now() - attempt.startedAt,
        cleanupErrors,
      })
      return
    }
    if (failure) {
      this.options.onEvent({
        type: 'late-setup-failure',
        slot: slot.id,
        revision: slot.service.key,
        env: envId,
        error: failure.error,
        cleanupErrors,
      })
    }
    else {
      this.options.onEvent({
        type: 'late-setup-result',
        slot: slot.id,
        revision: slot.service.key,
        env: envId,
        cleanupErrors,
      })
    }
  }

  private timeoutError(attempt: SetupAttempt, owner: SlotOwnerEnv, deadlineMs: number): SynaError {
    const now = Date.now()
    const slot = attempt.slot
    const pendingLoads = [...attempt.pendingLoads.values()].map(pending => ({
      revision: pending.target.service.key,
      slot: pending.target.id,
      state: pending.target.state,
      waitingMs: now - pending.since,
    }))
    const suspectedWaitCycle = this.findSuspectedWaitCycle(slot)
    return new SynaError(
      'INITIALIZATION_TIMEOUT',
      `Setup of ${slot.service.key} did not complete within ${deadlineMs} ms.${
        suspectedWaitCycle
          ? ` Observed load() calls form a cycle (${suspectedWaitCycle.join(' -> ')}); this is an observation, not a proof of deadlock.`
          : ''
      }`,
      {
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        attempt: attempt.id,
        deadlineMs,
        elapsedMs: now - attempt.startedAt,
        pendingLoads,
        ...(suspectedWaitCycle ? { suspectedWaitCycle } : {}),
        note: 'The deadline expired while setup was still pending. The attempt may still finish later; its result will be discarded and reported.',
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
      )
      this.assertOwnerUsable(owner, slot, 'recover')
      // A late cleanup may have failed during the cooldown: the slot is then final.
      if (slot.rollbackFailed) throw this.rollbackFailedError(slot)
      if (slot.state === 'ready') return slot.instance
      if (slot.state === 'starting' && slot.sequence) return slot.sequence
      if (slot.state !== 'failed') {
        throw new SynaError(
          'INVALID_ENV_STATE',
          `Cannot recover ${slot.service.key} from state ${slot.state}.`,
          { slot: slot.id, revision: slot.service.key, state: slot.state },
        )
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

  private assertOwnerUsable(
    owner: { readonly id: string; readonly state: EnvState; readonly abortController: AbortController },
    slot: ServiceSlot,
    action: string,
  ): void {
    assertNotAborted(
      owner.abortController.signal,
      `Cannot ${action} ${slot.service.key}: owner Env ${owner.id} is closing.`,
    )
    if (owner.state !== 'activating' && owner.state !== 'ready') {
      throw abortError(
        `Cannot ${action} ${slot.service.key} while owner Env ${owner.id} is ${owner.state}.`,
        { slot: slot.id, revision: slot.service.key, env: owner.id, state: owner.state },
      )
    }
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

  private async disposeServiceSlot(slot: ServiceSlot): Promise<void> {
    if (slot.state !== 'ready') return
    slot.state = 'disposing'
    const errors = await this.runCleanups(slot.cleanups, slot)
    slot.state = 'disposed'
    delete slot.instance
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map(item => item.error),
        `Service ${slot.service.key} failed to dispose cleanly.`,
      )
    }
  }

  /** Runs cleanups in reverse registration order; every cleanup runs even if an earlier one throws. */
  private async runCleanups(
    cleanups: Array<() => Awaitable<void>>,
    slot: ServiceSlot,
  ): Promise<readonly DisposableError[]> {
    const errors: DisposableError[] = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() }
      catch (error) { errors.push({ slot: slot.id, error }) }
    }
    return errors
  }
}

import type {
  Awaitable,
  DependencyRef,
  InputRef,
  LoadOptions,
  RuntimeEvent,
  ServiceLifecycle,
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
      readonly timedOut: boolean
      readonly cleanupErrors: readonly unknown[]
    }

type RaceResult =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

function isForeignThenable(value: unknown): boolean {
  if (value instanceof Promise) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

function raceDeadline(promise: Promise<unknown>, deadlineMs: number): Promise<RaceResult> {
  const settled = promise.then(
    (value): RaceResult => ({ kind: 'resolved', value }),
    (error): RaceResult => ({ kind: 'rejected', error }),
  )
  if (!Number.isFinite(deadlineMs)) return settled
  return new Promise<RaceResult>(resolve => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, deadlineMs))
    void settled.then(result => { clearTimeout(timer); resolve(result) })
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

  constructor(private readonly options: MaterializerOptions) {}

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
   * Waits for running sequences to end, then gives timed-out attempts the
   * disposal grace period to settle. Returns the slots whose attempt never did.
   */
  async settleSlots(slots: readonly ServiceSlot[]): Promise<readonly ServiceSlot[]> {
    for (const slot of slots) {
      if (slot.sequence && slot.state === 'starting') {
        try { await slot.sequence }
        catch { /* failure already recorded on the slot */ }
      }
    }
    const abandoned: ServiceSlot[] = []
    for (const slot of slots) {
      const attempt = slot.unsettledAttempt
      if (!attempt) continue
      const settled = await settlesWithin(attempt.settled, this.options.disposalGraceMs)
      if (settled) continue
      slot.state = 'abandoned'
      abandoned.push(slot)
      this.options.onEvent({
        type: 'attempt-abandoned',
        slot: slot.id,
        revision: slot.service.key,
        env: slot.ownerEnvId,
        elapsedMs: Date.now() - attempt.startedAt,
      })
    }
    return abandoned
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
    return waitWithSignal(value, options?.signal, () => ({
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
        if (outcome.timedOut) throw outcome.error
        if (outcome.cleanupErrors.length > 0) {
          // A failed rollback ends the sequence: retrying on top of leaked resources is not safe.
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
        if (slot.attempt !== attempt || attempt.state !== 'running') {
          throw new SynaError(
            'INVALID_ENV_STATE',
            `onDispose() for ${slot.service.key} may only be called during its active setup attempt.`,
            { slot: slot.id, revision: slot.service.key },
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
    const raced = await raceDeadline(rawPromise, deadlineMs)

    if (raced.kind === 'timeout') {
      attempt.state = 'timed-out'
      slot.unsettledAttempt = attempt
      const error = this.timeoutError(attempt, owner, deadlineMs)
      rawPromise.then(
        () => this.handleLateSettlement(attempt, owner, undefined),
        lateError => this.handleLateSettlement(attempt, owner, { error: lateError }),
      )
      return { ok: false, error, timedOut: true, cleanupErrors: [] }
    }

    attempt.rawSettled = true
    if (raced.kind === 'rejected') {
      const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot)).map(item => item.error)
      attempt.state = 'failed'
      attempt.resolveSettled()
      return { ok: false, error: raced.error, timedOut: false, cleanupErrors }
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
        timedOut: false,
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
    }
  }

  private async handleLateSettlement(
    attempt: SetupAttempt,
    owner: SlotOwnerEnv,
    failure: { readonly error: unknown } | undefined,
  ): Promise<void> {
    attempt.rawSettled = true
    const slot = attempt.slot
    const cleanupErrors = (await this.runCleanups(attempt.cleanups, slot)).map(item => item.error)
    if (slot.unsettledAttempt === attempt) delete slot.unsettledAttempt
    attempt.resolveSettled()
    if (failure) {
      this.options.onEvent({
        type: 'late-setup-failure',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
        error: failure.error,
        cleanupErrors,
      })
    }
    else {
      this.options.onEvent({
        type: 'late-setup-result',
        slot: slot.id,
        revision: slot.service.key,
        env: owner.id,
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
    const collect = (
      slot: RuntimeSlot,
      visited: Set<string>,
      output: Set<string>,
    ): void => {
      if (visited.has(slot.id)) return
      visited.add(slot.id)
      if (slot.kind === 'service') {
        if (included.has(slot.id)) output.add(slot.id)
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

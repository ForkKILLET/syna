import packageJson from '../package.json' with { type: 'json' }
import type {
  AnchoredEntry,
  Contract,
  CreateRuntimeOptions,
  DependencyMap,
  DependencyRefs,
  EntryArguments,
  EntryCallback,
  EntryCheck,
  EntryDescriptor,
  EntryExplanation,
  EntryOptions,
  EntryParameters,
  EntryRunArguments,
  ReuseConstraints,
  EnvHandle,
  EnvInspection,
  EnvInspectionNode,
  InputRef,
  LoadOptions,
  ImplementationRef,
  RuntimeCatalog,
  RuntimeEvent,
  RuntimeInspection,
  RuntimePolicy,
  RuntimePolicyContext,
  Runtime,
  ServiceFamily,
  ServiceRef,
  ServiceRevision,
} from './descriptors.js'
import { withDeprecatedScope } from './definition.js'
import { diagnosticFromError, SynaError } from './errors.js'
import type {
  EnvState,
  ResolvedPlan,
  ResolutionRealm,
  RuntimeSlot,
  ServiceSlot,
} from './internal/runtime-model.js'
import { defaultVersionOrder } from './internal/identity.js'
import { PUBLIC_REALM } from './internal/resolution-realm.js'
import { Materializer } from './internal/materializer.js'
import { DefinitionCompiler } from './internal/definition-compiler.js'
import { ImplementationDirectory } from './internal/implementation-directory.js'
import { EntryPlanner, entryDefinitionSignature } from './internal/entry-planner.js'
import {
  createImplementationSet,
  createSelector,
  type ImplementationViewHost,
} from './internal/implementation-views.js'
import { isBacktrackableTopologyError } from './internal/solve-errors.js'

const DEFAULT_DEADLINE_MS = 30_000
const DEFAULT_DISPOSAL_GRACE_MS = 2_000
const DEFAULT_SEARCH_BUDGET = 10_000
const DEFAULT_PLAN_CACHE_ENTRIES = 512

const internalPackage = Object.freeze({
  name: '@syna/core',
  id: '@syna/core',
  version: packageJson.version,
  metadata: Object.freeze({}),
})

const internalDeriveEntry: EntryDescriptor<{}, {}> = Object.freeze(withDeprecatedScope({
  kind: 'entry' as const,
  package: internalPackage,
  id: '@syna/core/entry/derive/v1',
  apiVersion: 1,
  requires: Object.freeze({}),
  parameters: Object.freeze({}),
  reuse: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
  metadata: Object.freeze({}),
}))

/** One Entry call after the public argument shapes are normalized. */
interface EntryCall {
  readonly parameters: Readonly<Record<string, unknown>> | undefined
  readonly reuse: ReuseConstraints | undefined
}

const EMPTY_CALL: EntryCall = Object.freeze({ parameters: undefined, reuse: undefined })

/**
 * Splits `(parameters?, options?)` into the parameter record and the reuse
 * constraints. The 0.5 form carried `scope` inside the parameter record (R1
 * alias, removed in 0.7.0): it is lifted into the constraints and refused when
 * the options argument is present as well, so one call never has two sources.
 * `reuse` is never a parameter key. A non-object parameter value is passed on
 * unchanged and rejected by the planner (`INVALID_DESCRIPTOR`) as before.
 */
function entryCall(parameters: unknown, options: unknown): EntryCall {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('Entry call options must be an object.')
  }
  const reuse = (options as EntryOptions | undefined)?.reuse
  if (typeof parameters !== 'object' || parameters === null) {
    return { parameters: parameters as undefined, reuse }
  }
  const record = parameters as Readonly<Record<string, unknown>>
  if ('reuse' in record) {
    throw new TypeError('reuse is a call option, not a parameter: enter(entry, parameters, { reuse }).')
  }
  if (!('scope' in record)) return { parameters: record, reuse }
  if (options !== undefined) {
    throw new TypeError('Reuse constraints were given both as parameters.scope (deprecated) and as options.reuse; use options.reuse.')
  }
  const { scope, ...rest } = record
  return { parameters: rest, reuse: scope as ReuseConstraints | undefined }
}

/**
 * A malformed call shape is reported as a rejection, never as a synchronous
 * throw: `enter`/`check`/`explain` returned Promises for every failure in 0.5
 * and still do. A well-formed call keeps its synchronous planning prefix.
 */
function withCall<T>(parameters: unknown, options: unknown, run: (call: EntryCall) => Promise<T>): Promise<T> {
  let call: EntryCall
  try {
    call = entryCall(parameters, options)
  }
  catch (error) {
    return Promise.reject(error)
  }
  return run(call)
}

/** `run(entry, [parameters, [options,]] callback)`: the callback is always last. */
function runCall<E extends EntryDescriptor, Result>(
  args: EntryRunArguments<E, Result>,
): { readonly call: EntryCall; readonly callback: EntryCallback<E, Result> } {
  const list = args as readonly unknown[]
  if (list.length === 1) return { call: entryCall({}, undefined), callback: list[0] as EntryCallback<E, Result> }
  if (list.length === 2) return { call: entryCall(list[0], undefined), callback: list[1] as EntryCallback<E, Result> }
  return { call: entryCall(list[0], list[1]), callback: list[2] as EntryCallback<E, Result> }
}

function addSuppressed(primary: unknown, cleanup: unknown): unknown {
  if (primary instanceof Error && Object.isExtensible(primary)) {
    Object.defineProperty(primary, 'suppressed', {
      configurable: true,
      enumerable: false,
      value: cleanup,
    })
    return primary
  }
  return new AggregateError(
    [primary, cleanup],
    'Entry execution and Env disposal both failed.',
    primary instanceof Error ? { cause: primary } : undefined,
  )
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number.`)
  }
  return value
}

export const defaultRuntimePolicy: RuntimePolicy = Object.freeze({
  orderAutoCandidates(
    contract: Contract,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ) {
    const families = new Set(candidates.map(candidate => candidate.family.id))
    if (families.size > 1) {
      throw new SynaError(
        'MISSING_AUTO_POLICY',
        `auto(${contract.id}) has multiple implementation families, but this Runtime has no explicit auto-selection policy.`,
        { contract: contract.id, site: context.site, families: [...families].sort() },
      )
    }
    return defaultVersionOrder(candidates, context.parentActiveRevisionKeys)
  },

  orderVersionCandidates(
    _family: ServiceFamily,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ) {
    return defaultVersionOrder(candidates, context.parentActiveRevisionKeys)
  },
})

class EnvImpl<Requires extends DependencyMap> implements EnvHandle<Requires> {
  readonly children = new Set<EnvImpl<any>>()
  readonly deps: DependencyRefs<Requires>
  readonly abortController = new AbortController()
  state: EnvState = 'activating'
  /**
   * Resolves when the Env reaches `disposed`: every owned attempt settled and
   * every descendant finalized. Only a parent that is itself closing waits on
   * it; the Runtime holds no reference to an Env after its bounded close.
   */
  readonly finalized: Promise<void>
  markFinalized: () => void = () => undefined
  private disposePromise?: Promise<void>

  constructor(
    readonly runtime: RuntimeImpl,
    readonly id: string,
    readonly parent: EnvImpl<any> | undefined,
    readonly plan: ResolvedPlan,
    rootSiteByEntryKey: ReadonlyMap<string, string>,
  ) {
    this.finalized = new Promise<void>(resolve => { this.markFinalized = resolve })
    const refs: Record<string, ServiceRef<unknown> | InputRef<unknown>> = {}
    for (const [key, rootSiteId] of rootSiteByEntryKey) {
      const nodeId = plan.rootNodeBySite.get(rootSiteId)!
      const slot = plan.slotsByNode.get(nodeId)!
      refs[key] = runtime.createRefFor(slot)
    }
    this.deps = Object.freeze(refs) as unknown as DependencyRefs<Requires>
  }

  enter<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>> {
    return withCall(args[0], args[1], call => this.runtime.enterFrom(this, descriptor, call, PUBLIC_REALM))
  }

  async run<E extends EntryDescriptor<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result> {
    const { call, callback } = runCall(args)
    const child = await this.runtime.enterFrom(this, descriptor, call, PUBLIC_REALM)
    return this.runtime.executeStructured(child, () => Promise.resolve(callback(child.deps, child)))
  }

  check<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck> {
    return withCall(args[0], args[1], call => this.runtime.checkFrom(this, descriptor, call, PUBLIC_REALM))
  }

  explain<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryExplanation> {
    return withCall(args[0], args[1], call => this.runtime.explainFrom(this, descriptor, call, PUBLIC_REALM))
  }

  derive(reuse: ReuseConstraints = {}): Promise<EnvHandle<{}>> {
    return this.runtime.enterFrom(this, internalDeriveEntry, { parameters: undefined, reuse }, PUBLIC_REALM)
  }

  anchor<E extends EntryDescriptor>(descriptor: E): AnchoredEntry<E> {
    return this.runtime.createAnchoredEntry(descriptor, this.id, PUBLIC_REALM)
  }

  /** @deprecated R2 alias of `anchor()`; removed in 0.7.0. */
  bind<E extends EntryDescriptor>(descriptor: E): AnchoredEntry<E> {
    return this.anchor(descriptor)
  }

  inspect(): EnvInspection {
    const nodes: EnvInspectionNode[] = [...this.plan.nodes.values()]
      .map(node => {
        const slot = this.plan.slotsByNode.get(node.id)!
        return {
          nodeId: node.id,
          kind: node.kind,
          label: node.label,
          slotId: slot.id,
          ownerEnvId: slot.ownerEnvId,
          state: slot.state,
          dependencies: Object.fromEntries(
            [...slot.requires.entries()].map(([key, dependency]) => [key, dependency.id]),
          ),
        }
      })
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))

    return {
      id: this.id,
      ...(this.parent ? { parentId: this.parent.id } : {}),
      state: this.state,
      nodes,
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.runtime.disposeEnv(this)
    return this.disposePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}

class RuntimeImpl implements Runtime, ImplementationViewHost {
  readonly policy: RuntimePolicy
  readonly catalog: RuntimeCatalog
  readonly roots = new Set<EnvImpl<any>>()
  readonly directory: ImplementationDirectory
  readonly internalPackage = internalPackage

  private readonly compiler: DefinitionCompiler
  private readonly materializer: Materializer
  private readonly disposalGraceMs: number
  private readonly envById = new Map<string, EnvImpl<any>>()
  private readonly planner: EntryPlanner
  private readonly onEvent: (event: RuntimeEvent) => void

  private disposed = false
  private disposePromise?: Promise<void>

  constructor(options: CreateRuntimeOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('createRuntime() expects an options object.')
    }
    const policy = options.policy ?? {}
    this.policy = Object.freeze({
      orderAutoCandidates:
        policy.orderAutoCandidates ?? defaultRuntimePolicy.orderAutoCandidates,
      orderVersionCandidates:
        policy.orderVersionCandidates ?? defaultRuntimePolicy.orderVersionCandidates,
    })
    const onEvent = options.diagnostics?.onEvent
    this.onEvent = event => {
      if (!onEvent) return
      try { onEvent(event) }
      catch { /* diagnostics must never change business outcomes */ }
    }

    this.compiler = new DefinitionCompiler(
      options.services,
      options.overrides ?? [],
      entryDefinitionSignature,
    )
    this.directory = new ImplementationDirectory(this.compiler.admitted, this.policy)
    this.planner = new EntryPlanner(
      this.compiler,
      this.directory,
      this.policy,
      options.planCache?.maxEntries ?? DEFAULT_PLAN_CACHE_ENTRIES,
      options.planning?.searchBudget ?? DEFAULT_SEARCH_BUDGET,
    )
    this.disposalGraceMs = positiveNumber(options.disposal?.graceMs, DEFAULT_DISPOSAL_GRACE_MS, 'disposal.graceMs')
    this.materializer = new Materializer({
      deadlineMs: positiveNumber(options.initialization?.deadlineMs, DEFAULT_DEADLINE_MS, 'initialization.deadlineMs'),
      disposalGraceMs: this.disposalGraceMs,
      onEvent: this.onEvent,
    })

    this.catalog = Object.freeze({
      implementations: <C extends Contract>(contract: C) =>
        this.directory.implementations(contract),
      resolve: <C extends Contract>(ref: ImplementationRef<C>) =>
        this.directory.resolveCatalog(ref),
      revisions: (familyId: string) => this.directory.revisions(familyId),
    })
  }

  inspect(): RuntimeInspection {
    const planCache = this.planner.cacheStats()
    const definitions = this.compiler.inspect()
    return {
      admittedServices: definitions.admittedServices,
      internalServices: definitions.internalServices,
      overriddenServices: definitions.overriddenServices,
      definitions: definitions.definitions,
      rootEnvCount: [...this.roots].filter(root => root.state !== 'disposed').length,
      liveEnvCount: this.envById.size,
      unsettledAttempts: this.materializer.unsettledAttempts(),
      planCache,
      definitionWarnings: definitions.warnings,
    }
  }

  enter<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>> {
    return withCall(args[0], args[1], call => this.enterFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  async run<E extends EntryDescriptor<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result> {
    const { call, callback } = runCall(args)
    const env = await this.enterFrom(undefined, descriptor, call, PUBLIC_REALM)
    return this.executeStructured(env, () => Promise.resolve(callback(env.deps, env)))
  }

  check<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck> {
    return withCall(args[0], args[1], call => this.checkFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  explain<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryExplanation> {
    return withCall(args[0], args[1], call => this.explainFrom(undefined, descriptor, call, PUBLIC_REALM))
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      const roots = [...this.roots]
      for (const root of roots) this.broadcastClosing(root)
      const errors = (await Promise.allSettled(roots.map(root => root.dispose())))
        .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
      this.planner.clearCache()
      // Envs that completed their bounded close earlier are no longer roots, but an
      // attempt they abandoned may still be pending, or its late close (cleanups)
      // may be running: give the latter the grace, then report whatever is still
      // outstanding instead of fulfilling as if everything had settled.
      await this.materializer.awaitSettling(this.disposalGraceMs)
      const outstanding = this.materializer.unsettledAttempts()
      if (outstanding.length > 0) {
        errors.push(new SynaError(
          'UNSETTLED_ATTEMPT',
          `The Runtime closed while ${outstanding.length} setup attempt(s) were still running, rolling back or being cleaned up; their resources are not under Syna control.`,
          { attempts: outstanding },
        ))
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more Syna root Envs failed to dispose.')
      }
    })()
    return this.disposePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  // ImplementationViewHost ------------------------------------------------------

  activeRevisionKeys(envId: string): ReadonlySet<string> {
    return this.planner.activeRevisionKeys(this.envById.get(envId)?.plan)
  }

  checkPlanOnly(anchorEnvId: string, descriptor: EntryDescriptor, realm: ResolutionRealm): Promise<EntryCheck> {
    const anchor = this.requireEnv(anchorEnvId)
    return this.checkFrom(anchor, descriptor, EMPTY_CALL, realm, true)
  }

  loadSlot(slot: RuntimeSlot, options?: LoadOptions): Promise<unknown> {
    return this.materializer.load(slot, options)
  }

  async executeStructured<Result>(
    env: EnvHandle,
    callback: () => Promise<Result> | Result,
  ): Promise<Result> {
    let result: Result
    try {
      result = await callback()
    }
    catch (primary) {
      try { await env.dispose() }
      catch (cleanup) { throw addSuppressed(primary, cleanup) }
      throw primary
    }
    try {
      await env.dispose()
    }
    catch (closeError) {
      // The callback succeeded and only the close reports: its result travels with the error.
      if (typeof closeError === 'object' && closeError !== null) {
        Object.defineProperty(closeError, 'result', { value: result, enumerable: false, configurable: true, writable: true })
      }
      throw closeError
    }
    return result
  }

  /**
   * An AnchoredEntry is anchored at one Env id. Entering requires that Env to be
   * Ready: an owner that is still activating yields OWNER_NOT_READY, a plain
   * rejected Promise the caller may catch. Planning (`check`/`explain`) only
   * plans: it runs no setup, publishes no Env, leaves no anchor and consumes no
   * Env id; it registers the descriptors it meets and may fill the plan cache,
   * both bounded by the static definition set. It is allowed while the anchor
   * activates.
   */
  createAnchoredEntry<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    anchorEnvId: string,
    realm: ResolutionRealm,
  ): AnchoredEntry<E> {
    const anchor = (): EnvImpl<any> => this.requireEnv(anchorEnvId)
    // async: a dead anchor (`requireEnv`) rejects, as in 0.5, instead of throwing synchronously.
    const enterAnchored = async (...args: EntryArguments<E>): Promise<EnvHandle<E['requires']>> =>
      withCall(args[0], args[1], call => this.enterFrom(anchor(), descriptor, call, realm))

    const runAnchored = async <Result>(...args: EntryRunArguments<E, Result>): Promise<Result> => {
      const { call, callback } = runCall(args)
      const child = await this.enterFrom(anchor(), descriptor, call, realm)
      return this.executeStructured(child, () => Promise.resolve(callback(child.deps, child)))
    }

    return Object.freeze({
      enter: enterAnchored,
      run: runAnchored,
      check: async (...args: EntryArguments<E>) =>
        withCall(args[0], args[1], call => this.checkFrom(anchor(), descriptor, call, realm, true)),
      explain: async (...args: EntryArguments<E>) =>
        withCall(args[0], args[1], call => this.explainFrom(anchor(), descriptor, call, realm, true)),
    })
  }

  async checkFrom<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
  ): Promise<EntryCheck> {
    try {
      const { plan } = this.planEntry(parent, descriptor, call, true, allowActivatingParent, realm)
      return Object.freeze({ ok: true, inspection: this.planner.inspect(plan) })
    }
    catch (error) {
      if (!isBacktrackableTopologyError(error)) throw error
      return Object.freeze({ ok: false, error: diagnosticFromError(error) })
    }
  }

  async explainFrom<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
  ): Promise<EntryExplanation> {
    try {
      const { plan } = this.planEntry(parent, descriptor, call, true, allowActivatingParent, realm)
      return this.planner.explain(plan, descriptor, parent)
    }
    catch (error) {
      if (!isBacktrackableTopologyError(error)) throw error
      const missing = collectMissingParameters(error.code, error.details)
      return Object.freeze({
        ok: false,
        entry: descriptor.id,
        ...(parent ? { parent: parent.id } : {}),
        error: diagnosticFromError(error),
        missingInputs: Object.freeze([...missing.inputs]),
        missingBindings: Object.freeze([...missing.bindings]),
      })
    }
  }

  async enterFrom<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    realm: ResolutionRealm = PUBLIC_REALM,
  ): Promise<EnvImpl<E['requires']>> {
    const { envId, plan, rootSiteByEntryKey } = this.planEntry(parent, descriptor, call, false, false, realm)
    const env = new EnvImpl<E['requires']>(this, envId, parent, plan, rootSiteByEntryKey)
    this.envById.set(env.id, env)

    for (const slot of new Set(plan.slotsByNode.values())) {
      if (slot.kind === 'service' && slot.ownerEnvId === envId) slot.ownerEnv = env
    }

    if (parent) parent.children.add(env)
    else this.roots.add(env)

    try {
      await this.prepareSyntheticValues(env)
      await this.activateEnv(env)
      if (env.state !== 'activating') {
        throw new SynaError(
          'INVALID_ENV_STATE',
          `Env ${env.id} was closed before activation completed.`,
          { env: env.id, state: env.state },
        )
      }
      env.state = 'ready'
      return env
    }
    catch (error) {
      // Activation failures are always reported as ENTRY_ACTIVATION_FAILED with
      // the underlying error as `cause`, whatever its type. Planning errors are
      // thrown before this point and keep their own codes.
      const failure = new SynaError(
        'ENTRY_ACTIVATION_FAILED',
        `Entry ${descriptor.id} failed while activating Env ${envId}: ${error instanceof Error ? error.message : String(error)}`,
        {
          entry: descriptor.id,
          env: envId,
          ...(error instanceof SynaError ? { causeCode: error.code, causeDetails: error.details } : {}),
        },
        { cause: error },
      )
      try { await env.dispose() }
      catch (cleanup) { throw addSuppressed(failure, cleanup) }
      throw failure
    }
  }

  createRefFor(slot: RuntimeSlot): ServiceRef<unknown> | InputRef<unknown> {
    return slot.kind === 'input'
      ? this.materializer.createInputRef(slot)
      : this.materializer.createRef(slot)
  }

  private requireEnv(envId: string): EnvImpl<any> {
    const env = this.envById.get(envId)
    if (!env) {
      throw new SynaError(
        'INVALID_ENV_STATE',
        `Env ${envId} is no longer live.`,
        { env: envId },
      )
    }
    return env
  }

  private planEntry<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    call: EntryCall,
    checking: boolean,
    allowActivatingParent: boolean,
    realm: ResolutionRealm,
  ): {
    readonly envId: string
    readonly plan: ResolvedPlan
    readonly rootSiteByEntryKey: ReadonlyMap<string, string>
  } {
    this.assertEntryUsable(parent, descriptor, allowActivatingParent)
    return this.planner.plan(parent, descriptor, call.parameters as EntryParameters<E> | undefined, call.reuse, checking, realm)
  }

  private assertEntryUsable(
    parent: EnvImpl<any> | undefined,
    descriptor: EntryDescriptor,
    allowActivatingParent: boolean,
  ): void {
    if (this.disposed) throw new SynaError('INVALID_ENV_STATE', 'The Syna Runtime is disposed.')
    if (typeof descriptor !== 'object' || descriptor === null || descriptor.kind !== 'entry') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected an Entry descriptor.')
    }
    if (!parent) return
    if (parent.runtime !== this) {
      throw new SynaError('RUNTIME_MISMATCH', 'An Entry anchor belongs to another Runtime.')
    }
    if (parent.state === 'ready') return
    if (parent.state === 'activating') {
      if (allowActivatingParent) return
      throw new SynaError(
        'OWNER_NOT_READY',
        `Cannot enter ${descriptor.id} from Env ${parent.id} while it is still activating. Finish setup first and start child worlds from a Ready owner (for example from a host-driven start() method).`,
        { entry: descriptor.id, env: parent.id, state: parent.state },
      )
    }
    throw new SynaError(
      'INVALID_ENV_STATE',
      `Cannot enter from Env ${parent.id} while it is ${parent.state}.`,
      { entry: descriptor.id, env: parent.id, state: parent.state },
    )
  }

  private async prepareSyntheticValues(env: EnvImpl<any>): Promise<void> {
    for (const node of env.plan.nodes.values()) {
      const slot = env.plan.slotsByNode.get(node.id)!
      if (slot.ownerEnvId !== env.id || slot.kind === 'service' || slot.kind === 'input' || slot.value !== undefined) {
        continue
      }
      if (node.kind === 'selector') {
        slot.value = await createSelector(this, node, slot, this.anchorEnvId(node.anchorNodeId, env))
      }
      else if (node.kind === 'all') slot.value = createImplementationSet(this, node, slot, env.id)
      else if (node.kind === 'entry') {
        slot.value = this.createAnchoredEntry(node.entry, this.anchorEnvId(node.anchorNodeId, env), node.realm)
      }
      Object.freeze(slot.requires)
    }
  }

  private anchorEnvId(anchorNodeId: string | undefined, fallback: EnvImpl<any>): string {
    if (!anchorNodeId) return fallback.id
    const anchorSlot = fallback.plan.slotsByNode.get(anchorNodeId)
    if (!anchorSlot) {
      throw new SynaError('INVALID_ENV_STATE', `Missing anchor node ${anchorNodeId}.`, { node: anchorNodeId })
    }
    return anchorSlot.ownerEnvId
  }

  /** Ready means every eager slot owned by this Env is Ready; inherited eager slots are already Ready in their owner. */
  private async activateEnv(env: EnvImpl<any>): Promise<void> {
    const eager = [...new Set(env.plan.slotsByNode.values())]
      .filter((slot): slot is ServiceSlot =>
        slot.kind === 'service' && slot.ownerEnvId === env.id && slot.service.eager)
    await this.materializer.startEagerSlots(eager)
  }

  /**
   * Synchronously moves an Env and all of its descendants to `disposing` and
   * aborts their signals. From this point no Env in the subtree accepts new
   * work (enter/derive/load/recover) and every cooperative setup, worker or
   * cleanup in the subtree has seen the stop signal, before anything is waited
   * for. Idempotent.
   */
  private broadcastClosing(env: EnvImpl<any>): void {
    if (env.state === 'disposed') return
    env.state = 'disposing'
    env.abortController.abort()
    for (const child of env.children) this.broadcastClosing(child)
  }

  /**
   * Closing order: refuse new work and broadcast cancellation to the whole
   * subtree, wait for descendants (concurrently: sibling subtrees are
   * independent), give owned attempts the disposal grace period, then dispose
   * owned Ready slots dependant-first over the SCC condensation.
   *
   * That much is bounded by the grace period, and at its end the Env leaves the
   * tree and the Runtime's registries whatever is still pending: its parent no
   * longer waits for it and the Runtime never retains a closed Env. The Env's
   * *state* reaches `disposed` only once everything this close abandoned has
   * settled: its own attempts and those of the descendants closed by this same
   * call (a descendant that completed its own bounded close earlier has already
   * left the tree and holds nothing here). Until then dispose() has reported
   * the attempts (`UNSETTLED_ATTEMPT`) and the Env stays `disposing`. The
   * attempts themselves are listed in `inspect().unsettledAttempts` and are kept
   * alive only by the user's own pending setup Promise.
   */
  async disposeEnv(env: EnvImpl<any>): Promise<void> {
    if (env.state === 'disposed') return
    this.broadcastClosing(env)

    const children = [...env.children]
    const errors: unknown[] = (await Promise.allSettled(children.map(child => child.dispose())))
      .flatMap(result => (result.status === 'rejected' ? [result.reason] : []))

    const ownedServiceSlots = [...new Set(env.plan.slotsByNode.values())]
      .filter((slot): slot is ServiceSlot => slot.kind === 'service' && slot.ownerEnvId === env.id)

    const abandoned = await this.materializer.settleSlots(ownedServiceSlots)
    errors.push(...await this.materializer.disposeServiceSlots(ownedServiceSlots))

    for (const slot of ownedServiceSlots) {
      if (slot.state === 'dormant' || slot.state === 'failed') slot.state = 'disposed'
    }

    const pending: Promise<unknown>[] = [
      ...abandoned.map(item => item.attempt.settled),
      ...children.filter(child => child.state !== 'disposed').map(child => child.finalized),
    ]
    this.detachEnv(env)
    if (pending.length === 0) {
      this.finalizeEnv(env)
    }
    else {
      void Promise.all(pending).then(() => this.finalizeEnv(env))
    }

    if (abandoned.length > 0) {
      const phases = new Set(abandoned.map(item => (item.attempt.rawSettled ? 'rollback' : 'setup')))
      const activity = phases.size === 2 ? 'still running or rolling back' : phases.has('rollback') ? 'still rolling back' : 'still running'
      errors.push(new SynaError(
        'UNSETTLED_ATTEMPT',
        `Env ${env.id} closed while ${abandoned.length} setup attempt(s) were ${activity}; their resources are not under Syna control. The Env stays disposing until they settle.`,
        {
          env: env.id,
          state: env.state,
          slots: abandoned.map(item => ({
            slot: item.slot.id,
            revision: item.slot.service.key,
            attempt: item.attempt.id,
            // `rollback`: the setup already settled; its cleanups are what outlived the grace.
            phase: item.attempt.rawSettled ? 'rollback' : 'setup',
            // The attempt ignored the stop signal past the grace period; the slots it
            // depends on were closed in the normal order regardless (the Runtime cannot
            // revoke an instance it already handed out), which is acknowledged here.
            dependencies: [...item.slot.requires.entries()]
              .filter((entry): entry is [string, ServiceSlot] => entry[1].kind === 'service')
              .map(([dependency, target]) => ({
                dependency,
                slot: target.id,
                revision: target.service.key,
                state: target.state,
              })),
          })),
        },
      ))
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Env ${env.id} failed to dispose cleanly.`)
    }
  }

  /** Bounded close complete: the Runtime forgets the Env even if it is not yet `disposed`. */
  private detachEnv(env: EnvImpl<any>): void {
    env.parent?.children.delete(env)
    this.roots.delete(env)
    this.envById.delete(env.id)
  }

  private finalizeEnv(env: EnvImpl<any>): void {
    if (env.state === 'disposed') return
    env.state = 'disposed'
    env.markFinalized()
  }
}

/**
 * Missing parameters reported by a planning failure, wherever they occur: the
 * Entry's own declared-but-unprovided parameters (`details.missingInputs` /
 * `missingBindings`), a requirement deep inside the graph (`MISSING_INPUT` /
 * `MISSING_BINDING` with `details.missing`), or the same inside the per-candidate
 * failures of an `UNSATISFIABLE_TOPOLOGY` report.
 */
function collectMissingParameters(
  code: string,
  details: Readonly<Record<string, unknown>>,
): { readonly inputs: readonly string[]; readonly bindings: readonly string[] } {
  const inputs = new Set<string>()
  const bindings = new Set<string>()
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const visit = (nodeCode: string, nodeDetails: Readonly<Record<string, unknown>>): void => {
    const declared = Array.isArray(nodeDetails.missingInputs) || Array.isArray(nodeDetails.missingBindings)
    for (const id of strings(nodeDetails.missingInputs)) inputs.add(id)
    for (const id of strings(nodeDetails.missingBindings)) bindings.add(id)
    // Deep requirements (raised by the graph builder) carry the id under `missing` only.
    if (!declared && nodeCode === 'MISSING_INPUT') for (const id of strings(nodeDetails.missing)) inputs.add(id)
    if (!declared && nodeCode === 'MISSING_BINDING') for (const id of strings(nodeDetails.missing)) bindings.add(id)
    for (const failure of Array.isArray(nodeDetails.failures) ? nodeDetails.failures : []) {
      if (typeof failure !== 'object' || failure === null) continue
      const nested = failure as { code?: unknown; details?: unknown }
      if (typeof nested.code !== 'string') continue
      visit(nested.code, (typeof nested.details === 'object' && nested.details !== null ? nested.details : {}) as Readonly<Record<string, unknown>>)
    }
  }
  visit(code, details)
  return { inputs: [...inputs].sort(), bindings: [...bindings].sort() }
}

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  return new RuntimeImpl(options)
}

import packageJson from '../package.json' with { type: 'json' }
import type {
  BoundEntry,
  CandidateRef,
  Contract,
  CreateRuntimeOptions,
  DeriveOptions,
  DependencyMap,
  DependencyRef,
  DependencyRefs,
  EntryArguments,
  EntryCheck,
  EntryDescriptor,
  EntryParameters,
  EntryRunArguments,
  EnvHandle,
  EnvInspection,
  EnvInspectionNode,
  ImplementationCandidate,
  ImplementationLease,
  ImplementationSelector,
  ImplementationSet,
  PersistentImplementationRef,
  RuntimeCatalog,
  RuntimeInspection,
  RuntimePolicy,
  RuntimePolicyContext,
  ServiceFamily,
  ServiceRevision,
  SynaRuntime,
} from './descriptors.js'
import { asSynaError, diagnosticFromError, SynaError } from './errors.js'
import type {
  AllPlanNode,
  EnvState,
  ResolvedPlan,
  ResolutionRealm,
  RuntimeSlot,
  SelectorPlanNode,
  ServiceSlot,
  SyntheticSlot,
} from './internal/runtime-model.js'
import { defaultVersionOrder } from './internal/runtime-utils.js'
import { PUBLIC_REALM } from './internal/resolution-realm.js'
import { Materializer } from './internal/materializer.js'
import { DefinitionRegistry } from './internal/definition-registry.js'
import {
  ImplementationDirectory,
  type CandidateAvailabilityInput,
} from './internal/implementation-directory.js'
import {
  EntryPlanner,
  entryDefinitionSignature,
} from './internal/entry-planner.js'
import { isBacktrackableTopologyError } from './internal/solve-errors.js'


const internalPackage = Object.freeze({
  name: '@syna/core',
  id: '@syna/core',
  version: packageJson.version,
  metadata: Object.freeze({}),
})

const internalDeriveEntry: EntryDescriptor<{}, {}> = Object.freeze({
  kind: 'entry',
  package: internalPackage,
  id: '@syna/core/entry/derive/v1',
  apiVersion: 1,
  requires: Object.freeze({}),
  parameters: Object.freeze({}),
  scope: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
  metadata: Object.freeze({}),
})

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
  private disposePromise?: Promise<void>

  constructor(
    readonly runtime: RuntimeImpl,
    readonly id: string,
    readonly parent: EnvImpl<any> | undefined,
    readonly plan: ResolvedPlan,
    rootSiteByEntryKey: ReadonlyMap<string, string>,
  ) {
    const refs: Record<string, DependencyRef<unknown>> = {}
    for (const [key, rootSiteId] of rootSiteByEntryKey) {
      const nodeId = plan.rootNodeBySite.get(rootSiteId)!
      const slot = plan.slotsByNode.get(nodeId)!
      refs[key] = runtime.createDependencyRef(slot)
    }
    this.deps = Object.freeze(refs) as unknown as DependencyRefs<Requires>
  }

  enter<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>> {
    return this.runtime.enterFrom(this, descriptor, args[0] as EntryParameters<E> | undefined, PUBLIC_REALM)
  }

  async run<E extends EntryDescriptor<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result> {
    const [input, callback] = args.length === 1
      ? [{} as EntryParameters<E>, args[0]]
      : args
    const child = await this.runtime.enterFrom(this, descriptor, input, PUBLIC_REALM)
    return this.runtime.executeStructured(child as EnvImpl<any>, () => callback(child.deps, child))
  }

  check<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck> {
    return this.runtime.checkFrom(this, descriptor, args[0] as EntryParameters<E> | undefined, PUBLIC_REALM)
  }

  derive(options: DeriveOptions = {}): Promise<EnvHandle<{}>> {
    return this.runtime.enterFrom(this, internalDeriveEntry, { scope: options }, PUBLIC_REALM)
  }

  bind<E extends EntryDescriptor<any, any>>(descriptor: E): BoundEntry<E> {
    return this.runtime.createBoundEntry(descriptor, this, PUBLIC_REALM, false)
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

class RuntimeImpl implements SynaRuntime {
  readonly admittedRevisions: readonly ServiceRevision[]
  readonly policy: RuntimePolicy
  readonly catalog: RuntimeCatalog
  readonly roots = new Set<EnvImpl<any>>()

  private readonly definitions: DefinitionRegistry
  private readonly materializer = new Materializer()
  private readonly implementationDirectory: ImplementationDirectory
  private readonly envById = new Map<string, EnvImpl<any>>()
  private readonly planner: EntryPlanner

  private disposed = false
  private disposePromise?: Promise<void>

  constructor(options: CreateRuntimeOptions) {
    const policy = options.policy ?? {}
    this.policy = Object.freeze({
      orderAutoCandidates:
        policy.orderAutoCandidates ?? defaultRuntimePolicy.orderAutoCandidates,
      orderVersionCandidates:
        policy.orderVersionCandidates ?? defaultRuntimePolicy.orderVersionCandidates,
    })

    this.definitions = new DefinitionRegistry(
      options.services,
      options.overrides ?? [],
      entryDefinitionSignature,
    )
    this.admittedRevisions = this.definitions.admittedRevisions
    this.implementationDirectory = new ImplementationDirectory(
      this.admittedRevisions,
      this.policy,
    )
    this.planner = new EntryPlanner(
      this.definitions,
      this.implementationDirectory,
      this.policy,
      options.planCache?.maxEntries ?? 512,
    )

    this.catalog = Object.freeze({
      implementations: <C extends Contract>(contract: C) =>
        this.implementationDirectory.implementations(contract),
      resolve: <C extends Contract>(ref: PersistentImplementationRef<C>) =>
        this.implementationDirectory.resolveCatalog(ref),
    })
  }

  inspect(): RuntimeInspection {
    const planCache = this.planner.cacheStats()
    const definitions = this.definitions.inspect()
    return {
      admittedServices: definitions.admittedServices,
      internalServices: definitions.internalServices,
      rootEnvCount: [...this.roots].filter(root => root.state !== 'disposed').length,
      planCache,
      definitionWarnings: definitions.warnings,
    }
  }

  enter<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>> {
    return this.enterFrom(undefined, descriptor, args[0] as EntryParameters<E> | undefined, PUBLIC_REALM)
  }

  async run<E extends EntryDescriptor<any, any>, Result>(
    descriptor: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result> {
    const [input, callback] = args.length === 1
      ? [{} as EntryParameters<E>, args[0]]
      : args
    const env = await this.enterFrom(undefined, descriptor, input, PUBLIC_REALM)
    return this.executeStructured(env as EnvImpl<any>, () => callback(env.deps, env))
  }

  check<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck> {
    return this.checkFrom(undefined, descriptor, args[0] as EntryParameters<E> | undefined, PUBLIC_REALM)
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      if (this.disposed) return
      this.disposed = true
      const errors: unknown[] = []
      for (const root of [...this.roots]) {
        try { await root.dispose() }
        catch (error) { errors.push(error) }
      }
      this.planner.clearCache()
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more Syna root Envs failed to dispose.')
      }
    })()
    return this.disposePromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  async executeStructured<Result>(
    env: EnvImpl<any>,
    callback: () => PromiseLike<Result> | Result,
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
    await env.dispose()
    return result
  }

  createBoundEntry<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    anchor: EnvImpl<any>,
    realm: ResolutionRealm,
    allowActivatingAnchor: boolean,
  ): BoundEntry<E> {
    const enterBound = (...args: EntryArguments<E>): Promise<EnvHandle<E['requires']>> => {
      const frame = this.materializer.activeFrame()
      const operation = this.enterFrom(
        anchor,
        descriptor,
        args[0] as EntryParameters<E> | undefined,
        realm,
        allowActivatingAnchor,
        frame?.slot,
      )
      return this.materializer.trackStrongOperation(operation, frame)
    }

    const runBound = <Result>(...args: EntryRunArguments<E, Result>): Promise<Result> => {
      const frame = this.materializer.activeFrame()
      const [input, callback] = args.length === 1
        ? [{} as EntryParameters<E>, args[0]]
        : args
      const operation = (async () => {
        const child = await this.enterFrom(
          anchor,
          descriptor,
          input,
          realm,
          allowActivatingAnchor,
          frame?.slot,
        )
        return this.executeStructured(
          child as EnvImpl<any>,
          () => callback(child.deps, child),
        )
      })()
      return this.materializer.trackStrongOperation(operation, frame)
    }

    return Object.freeze({
      enter: enterBound,
      run: runBound,
      check: (...args: EntryArguments<E>) =>
        this.checkFrom(
          anchor,
          descriptor,
          args[0] as EntryParameters<E> | undefined,
          realm,
          allowActivatingAnchor,
        ),
    })
  }

  async checkFrom<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    input: EntryParameters<E> | undefined,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
    rethrowUnexpected = false,
  ): Promise<EntryCheck> {
    try {
      const { plan } = this.planEntry(
        parent,
        descriptor,
        input,
        true,
        allowActivatingParent,
        realm,
      )
      return Object.freeze({ ok: true, inspection: this.planner.inspect(plan) })
    }
    catch (error) {
      if (rethrowUnexpected && !isBacktrackableTopologyError(error)) throw error
      return Object.freeze({ ok: false, error: diagnosticFromError(error) })
    }
  }

  async enterFrom<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    input: EntryParameters<E> | undefined,
    realm: ResolutionRealm = PUBLIC_REALM,
    allowActivatingParent = false,
    activationRequester?: ServiceSlot,
  ): Promise<EnvHandle<E['requires']>> {
    const { envId, plan, rootSiteByEntryKey } = this.planEntry(
      parent,
      descriptor,
      input,
      false,
      allowActivatingParent,
      realm,
    )
    const env = new EnvImpl<E['requires']>(this, envId, parent, plan, rootSiteByEntryKey)
    this.envById.set(env.id, env)

    for (const slot of new Set(plan.slotsByNode.values())) {
      if (slot.kind === 'service' && slot.ownerEnvId === envId) slot.ownerEnv = env
    }

    if (parent) parent.children.add(env)
    else this.roots.add(env)

    const activationTaskId = `activation:${env.id}`
    if (activationRequester) {
      this.materializer.addWaitEdge(
        activationRequester.id,
        activationTaskId,
        activationRequester.revision.key,
        `Entry ${descriptor.id}`,
      )
    }

    try {
      await this.prepareSyntheticValues(env)
      await this.activateEnv(env, activationTaskId)
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
      try { await env.dispose() }
      catch (cleanup) { throw addSuppressed(error, cleanup) }
      throw asSynaError(
        error,
        'ENTRY_ACTIVATION_FAILED',
        `Entry ${descriptor.id} failed while activating Env ${envId}.`,
        { entry: descriptor.id, env: envId },
      )
    }
    finally {
      if (activationRequester) {
        this.materializer.removeWaitEdge(activationRequester.id, activationTaskId)
      }
    }
  }

  private planEntry<E extends EntryDescriptor<any, any>>(
    parent: EnvImpl<any> | undefined,
    descriptor: E,
    parameters: EntryParameters<E> | undefined,
    checking: boolean,
    allowActivatingParent: boolean,
    realm: ResolutionRealm,
  ): {
    readonly envId: string
    readonly plan: ResolvedPlan
    readonly rootSiteByEntryKey: ReadonlyMap<string, string>
  } {
    this.assertEntryUsable(parent, descriptor, allowActivatingParent)
    return this.planner.plan(
      parent,
      descriptor,
      parameters,
      checking,
      realm,
    )
  }

  private assertEntryUsable(
    parent: EnvImpl<any> | undefined,
    descriptor: EntryDescriptor,
    allowActivatingParent: boolean,
  ): void {
    if (this.disposed) throw new SynaError('INVALID_ENV_STATE', 'The Syna Runtime is disposed.')
    if (parent && parent.runtime !== this) {
      throw new SynaError('RUNTIME_MISMATCH', 'An Entry anchor belongs to another Runtime.')
    }
    if (parent && parent.state !== 'ready' && !(allowActivatingParent && parent.state === 'activating')) {
      throw new SynaError(
        'INVALID_ENV_STATE',
        `Cannot enter from Env ${parent.id} while it is ${parent.state}.`,
      )
    }
    if (descriptor.kind !== 'entry') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected an Entry descriptor.')
    }
  }

  createDependencyRef<T>(slot: RuntimeSlot): DependencyRef<T> {
    return this.materializer.createRef<T>(slot)
  }

  private async prepareSyntheticValues(env: EnvImpl<any>): Promise<void> {
    for (const node of env.plan.nodes.values()) {
      const slot = env.plan.slotsByNode.get(node.id)!
      if (slot.ownerEnvId !== env.id || slot.kind === 'service' || slot.kind === 'input' || slot.value !== undefined) {
        continue
      }
      if (node.kind === 'selector') slot.value = await this.createSelector(node, slot, env)
      else if (node.kind === 'all') slot.value = this.createImplementationSet(node, slot, env)
      else if (node.kind === 'entry') {
        const anchor = this.anchorForSyntheticNode(node.anchorNodeId, env.plan, env)
        slot.value = this.createBoundEntry(node.entry, anchor, node.realm, true)
      }
      Object.freeze(slot.requires)
    }
  }

  private anchorForSyntheticNode(
    anchorNodeId: string | undefined,
    plan: ResolvedPlan,
    fallback: EnvImpl<any>,
  ): EnvImpl<any> {
    if (!anchorNodeId) return fallback
    const anchorSlot = plan.slotsByNode.get(anchorNodeId)
    if (!anchorSlot) throw new SynaError('INVALID_ENV_STATE', `Missing anchor node ${anchorNodeId}.`)
    const anchor = this.envById.get(anchorSlot.ownerEnvId)
    if (!anchor) throw new SynaError('INVALID_ENV_STATE', `Missing anchor Env ${anchorSlot.ownerEnvId}.`)
    return anchor
  }

  private async createSelector(
    node: SelectorPlanNode,
    slot: SyntheticSlot,
    env: EnvImpl<any>,
  ): Promise<ImplementationSelector<any>> {
    const anchor = this.anchorForSyntheticNode(node.anchorNodeId, env.plan, env)
    const availabilityByRevision = new Map<string, CandidateAvailabilityInput>()
    const boundEntryByRevision = new Map<
      string,
      BoundEntry<EntryDescriptor<{ implementation: ServiceRevision<any> }, {}>>
    >()

    for (const revision of node.candidates) {
      const entry = this.candidateEntry(node.contract, revision)
      const check = await this.checkFrom(anchor, entry, {}, PUBLIC_REALM, true, true)
      boundEntryByRevision.set(
        revision.key,
        this.createBoundEntry(entry, anchor, PUBLIC_REALM, true),
      )
      availabilityByRevision.set(
        revision.key,
        check.ok
          ? Object.freeze({ status: 'available' as const })
          : Object.freeze({
              status: 'unavailable' as const,
              code: check.error.code,
              message: check.error.message,
              details: check.error.details,
            }),
      )
    }

    const index = this.implementationDirectory.createIndex({
      contract: node.contract,
      sourceSlotId: slot.id,
      revisions: node.candidates,
      availabilityByRevision,
      sitePrefix: node.dependencySite,
      parentActiveRevisionKeys: this.planner.activeRevisionKeys(anchor.plan),
    })

    const openCandidate = async (
      input: ImplementationCandidate<any> | CandidateRef<any> | PersistentImplementationRef<any>,
    ): Promise<ImplementationLease<any>> => {
      const candidate = index.requireAvailable(input)
      const boundEntry = boundEntryByRevision.get(index.revisionKey(candidate))!
      const candidateEnv = await boundEntry.enter()
      return Object.freeze({
        env: candidateEnv,
        implementation: candidateEnv.deps.implementation,
        dispose: () => candidateEnv.dispose(),
        [Symbol.asyncDispose]: () => candidateEnv.dispose(),
      })
    }

    const selector: ImplementationSelector<any> = {
      contract: node.contract,
      candidates: index.candidates,
      *[Symbol.iterator]() { yield* index.candidates },
      resolve: ref => index.resolve(ref),
      open: openCandidate,
      run: async (input, callback) => {
        const lease = await openCandidate(input)
        return this.executeStructured(
          lease.env as EnvImpl<any>,
          () => callback(lease.implementation, lease.env),
        )
      },
    }
    return Object.freeze(selector)
  }

  private createImplementationSet(
    node: AllPlanNode,
    slot: SyntheticSlot,
    env: EnvImpl<any>,
  ): ImplementationSet<any> {
    const slotByRevision = new Map<string, RuntimeSlot>()
    for (const revision of node.candidates) {
      slotByRevision.set(revision.key, slot.requires.get(revision.key)!)
    }
    const index = this.implementationDirectory.createIndex({
      contract: node.contract,
      sourceSlotId: slot.id,
      revisions: node.candidates,
      sitePrefix: `all:${node.contract.id}`,
      parentActiveRevisionKeys: this.planner.activeRevisionKeys(env.plan),
    })
    const implementationSet: ImplementationSet<any> = {
      contract: node.contract,
      candidates: index.candidates,
      *[Symbol.iterator]() { yield* index.candidates },
      resolve: ref => index.resolve(ref),
      load: async input => {
        const candidate = index.requireAvailable(input)
        return this.materializer.load(
          slotByRevision.get(index.revisionKey(candidate))!,
        )
      },
    }
    return Object.freeze(implementationSet)
  }

  private candidateEntry(
    contract: Contract,
    revision: ServiceRevision,
  ): EntryDescriptor<{ implementation: ServiceRevision<any> }, {}> {
    return Object.freeze({
      kind: 'entry',
      package: internalPackage,
      id: `@syna/core/entry/candidate/${contract.id}/${revision.key}/v1`,
      apiVersion: 1,
      requires: Object.freeze({ implementation: revision }),
      parameters: Object.freeze({}),
      scope: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
      metadata: Object.freeze({}),
    })
  }

  private async activateEnv(env: EnvImpl<any>, activationTaskId: string): Promise<void> {
    await this.materializer.activateOwnedEagerSlots(
      env,
      env.plan.slotsByNode.values(),
      activationTaskId,
    )
  }

  async disposeEnv(env: EnvImpl<any>): Promise<void> {
    if (env.state === 'disposed' || env.state === 'disposing') return
    env.state = 'disposing'
    const errors: unknown[] = []

    for (const child of [...env.children]) {
      try { await child.dispose() }
      catch (error) { errors.push(error) }
    }

    env.abortController.abort()
    const ownedServiceSlots = [...new Set(env.plan.slotsByNode.values())]
      .filter((slot): slot is ServiceSlot => slot.kind === 'service' && slot.ownerEnvId === env.id)

    await this.materializer.settleStartingSlots(ownedServiceSlots)
    errors.push(...await this.materializer.disposeServiceSlots(ownedServiceSlots))

    for (const slot of ownedServiceSlots) {
      if (slot.state === 'dormant' || slot.state === 'failed') slot.state = 'disposed'
    }

    env.state = 'disposed'
    env.parent?.children.delete(env)
    this.roots.delete(env)
    this.envById.delete(env.id)

    if (errors.length > 0) {
      throw new AggregateError(errors, `Env ${env.id} failed to dispose cleanly.`)
    }
  }

}

export function createRuntime(options: CreateRuntimeOptions): SynaRuntime {
  return new RuntimeImpl(options)
}

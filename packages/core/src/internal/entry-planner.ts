import type {
  Binding,
  BindingAssignment,
  Contract,
  Dependency,
  EntryDescriptor,
  EntryExplanationSuccess,
  EntryArguments,
  ExplainedNode,
  ForkCause,
  Input,
  PlannedEnvInspection,
  ReuseConstraints,
  ReuseTarget,
  RuntimePolicy,
  ServiceFamily,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { satisfiesVersion } from '../semver.js'
import { DefinitionCompiler } from './definition-compiler.js'
import { GraphBuilder, type GraphBuilderHost } from './graph-builder.js'
import { ImplementationDirectory } from './implementation-directory.js'
import { PlanTemplateCache, type CacheStats } from './plan-cache.js'
import type {
  BindingChoiceSlot,
  CompiledService,
  EnvPlanView,
  GraphBuildResult,
  InputSlot,
  NodeExplanation,
  PlanEntryParameters,
  PlanNode,
  ResolvedPlan,
  ResolutionRealm,
  RootSite,
  RuntimeSlot,
  ScopeTargetSet,
  ServicePlanNode,
  ServiceSlot,
  SyntheticSlot,
} from './runtime-model.js'
import { NeedChoice, PolicyContext } from './runtime-model.js'
import {
  compactDigest,
  dependencyIdentity,
  isServiceRevision,
  providesContract,
  stableJson,
  unwrapDependency,
} from './identity.js'
import { isBacktrackableTopologyError } from './solve-errors.js'

function graphSignature(
  graph: GraphBuildResult,
  choices: ReadonlyMap<string, string>,
): string {
  const nodes = [...graph.nodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(node => `${node.id}|${node.kind}|${node.label}|${[...node.edges.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, target]) => `${key}->${target}`)
      .join(',')}`)
  const selected = [...choices.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([site, revision]) => `${site}=${revision}`)
  return `${nodes.join(';')}#${selected.join(';')}`
}

export function entryDefinitionSignature(entry: EntryDescriptor): string {
  return stableJson({
    id: entry.id,
    apiVersion: entry.apiVersion,
    requires: Object.fromEntries(
      Object.entries(entry.requires)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, dependencyIdentity(value)]),
    ),
    parameters: Object.fromEntries(
      Object.entries(entry.parameters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, `${value.kind}:${value.id}`]),
    ),
    // The key is named after the 0.5 field on purpose: plan-template keys are unchanged by the rename.
    scope: { // syna-v05-compat: template key field, not the removed Entry option
      fresh: (entry.reuse.fresh ?? []).map(scopeTargetIdentity).sort(),
      share: (entry.reuse.share ?? []).map(scopeTargetIdentity).sort(),
    },
  })
}

function scopeTargetIdentity(target: ReuseTarget): string {
  if (typeof target !== 'object' || target === null) {
    throw new SynaError('INVALID_DESCRIPTOR', 'Reuse targets must be Service revisions or families.', { descriptor: 'ReuseTarget', problem: 'not-an-object' })
  }
  return target.kind === 'service-revision'
    ? `revision:${target.key}`
    : `family:${target.id}`
}

function scopeTargetSet(targets: readonly ReuseTarget[] | undefined): ScopeTargetSet {
  const revisionKeys = new Set<string>()
  const familyIds = new Set<string>()
  for (const target of targets ?? []) {
    scopeTargetIdentity(target)
    if (target.kind === 'service-revision') revisionKeys.add(target.key)
    else familyIds.add(target.id)
  }
  return { revisionKeys, familyIds }
}

function targetSetHas(set: ScopeTargetSet, revision: CompiledService): boolean {
  return set.revisionKeys.has(revision.key) || set.familyIds.has(revision.family.id)
}

function scopeTargetLabel(set: ScopeTargetSet, revision: CompiledService): string {
  return set.revisionKeys.has(revision.key) ? revision.key : revision.family.id
}

interface CachedGraphTemplate {
  readonly graph: GraphBuildResult
  readonly choices: ReadonlyMap<string, string>
  readonly signature: string
  /** Full signature of the parent plan this template was solved under; verified on every hit. */
  readonly parentSignature: string | undefined
}

export interface PlanningParent extends EnvPlanView {
  readonly id: string
}

export interface PlannedEntry {
  readonly envId: string
  readonly plan: ResolvedPlan
  readonly rootSiteByEntryKey: ReadonlyMap<string, string>
}

interface ReuseCandidate {
  readonly slot: RuntimeSlot
  readonly viaAnchor: boolean
}

/**
 * Compiles immutable Entry declarations into resolved node graphs and canonical
 * logical slots. It has no authority to materialize a Service or mutate a live
 * Env: it only reads the parent's plan and produces a new plan.
 *
 * Reuse is parent-only: a node reuses a slot when the parent currently exposes
 * the same nominal node with identical dependency slots (fixed point over the
 * reverse dependency graph). The single exception is a lineage-unique family
 * whose anchored slot may be re-attached when every dependency slot matches.
 */
export class EntryPlanner implements GraphBuilderHost {
  readonly admitted: readonly CompiledService[]

  private readonly planTemplates: PlanTemplateCache<CachedGraphTemplate>
  private nextEnvNumber = 1
  /** check()/explain() number their plans separately: planning consumes no Env id. */
  private nextCheckNumber = 1
  private nextSlotNumber = 1
  /** Slots of check()/explain() plans are numbered separately as well: planning leaves no trace in the ids of real Envs. */
  private nextCheckSlotNumber = 1

  constructor(
    private readonly compiler: DefinitionCompiler,
    private readonly directory: ImplementationDirectory,
    readonly policy: RuntimePolicy,
    maxCacheEntries: number,
    private readonly searchBudget: number,
  ) {
    this.admitted = compiler.admitted
    this.planTemplates = new PlanTemplateCache(maxCacheEntries)
    if (!Number.isSafeInteger(searchBudget) || searchBudget < 1) {
      throw new TypeError('limits.planningBudget must be a positive safe integer.')
    }
  }

  cacheStats(): CacheStats {
    return this.planTemplates.stats()
  }

  clearCache(): void {
    this.planTemplates.clear()
  }

  plan<E extends EntryDescriptor<any, any>>(
    parent: PlanningParent | undefined,
    descriptor: E,
    input: EntryArguments<E> | undefined,
    reuse: ReuseConstraints | undefined,
    checking: boolean,
    realm: ResolutionRealm,
  ): PlannedEntry {
    this.compiler.registerEntry(descriptor)
    if (input !== undefined && (typeof input !== 'object' || input === null)) {
      throw new SynaError('INVALID_DESCRIPTOR', `Entry ${descriptor.id} parameters must be an object.`, { descriptor: descriptor.id, problem: 'parameters-not-an-object' })
    }

    const envId = checking ? `check-${this.nextCheckNumber++}` : `env-${this.nextEnvNumber++}`
    const normalizedInput = (input ?? {}) as EntryArguments<E>
    const inputs = this.prepareInputs(envId, parent, descriptor, normalizedInput)
    const bindings = this.prepareBindings(envId, parent, descriptor, normalizedInput)
    if (inputs.missing.length > 0 || bindings.missing.length > 0) {
      const code = inputs.missing.length > 0 ? 'MISSING_INPUT' : 'MISSING_BINDING'
      throw new SynaError(
        code,
        `Entry ${descriptor.id} is missing ${[
          ...inputs.missing.map(item => `input ${item}`),
          ...bindings.missing.map(item => `binding ${item}`),
        ].join(', ')}.`,
        {
          entry: descriptor.id,
          missing: [...inputs.missing, ...bindings.missing],
          missingInputs: inputs.missing,
          missingBindings: bindings.missing,
        },
      )
    }

    const lineageKey = `${parent?.plan.lineageKey ?? 'root'}>${descriptor.id}`
    const rootSiteByEntryKey = new Map<string, string>()
    const rootSites = [...(parent?.plan.rootSites ?? [])]
    const ownRootSites: RootSite[] = []

    // Key order, not insertion order: two copies of one Entry that differ only in
    // the order of their `requires` literal plan the same topology.
    for (const [key, dependency] of (Object.entries(descriptor.requires) as [string, Dependency][]).sort(([a], [b]) => a.localeCompare(b))) {
      const rootSite: RootSite = {
        id: `${lineageKey}/require:${key}`,
        entryId: descriptor.id,
        key,
        dependency,
        realm,
      }
      rootSites.push(rootSite)
      ownRootSites.push(rootSite)
      rootSiteByEntryKey.set(key, rootSite.id)
    }

    const fresh = this.mergeScopeTargets(descriptor.reuse.fresh, reuse?.fresh)
    const share = this.mergeScopeTargets(descriptor.reuse.share, reuse?.share)
    const planInput: PlanEntryParameters = {
      envId,
      checking,
      realm,
      lineageKey,
      ...(parent ? { parent } : {}),
      rootSites,
      inputSlots: inputs.slots,
      providedInputIds: inputs.providedIds,
      bindingChoices: bindings.choices,
      changedBindingIds: bindings.changedIds,
      inheritedChoices: parent?.plan.choices ?? new Map(),
      fresh,
      share,
    }

    const templateKey = this.planTemplateKey(parent, descriptor, inputs.slots, bindings.choices, fresh, share, realm)
    const cached = this.planTemplates.get(templateKey)
    if (cached && cached.parentSignature === parent?.plan.signature) {
      // The template was solved for a copy of this Entry referencing the same
      // revision keys; this copy may hold other physical descriptors. A cold plan
      // registers and checks them while it builds the graph; a hit does it here,
      // so a drifted copy is DUPLICATE_DEFINITION whatever the cache holds (R17, D40).
      this.registerRootSiteDescriptors(ownRootSites)
      try {
        return {
          envId,
          plan: this.assignSlots(planInput, cached.graph, cached.choices, cached.signature),
          rootSiteByEntryKey,
        }
      }
      catch (error) {
        // Defence in depth behind the key: a template whose choices no longer fit
        // this parent's lineage is evicted and the plan is solved afresh instead of
        // reporting a conflict a cold plan would not have had.
        if (!isBacktrackableTopologyError(error)) throw error
        this.planTemplates.delete(templateKey)
      }
    }

    const budget = { remaining: this.searchBudget }
    const solved = this.solvePlanTemplate(planInput, new Map(planInput.inheritedChoices), budget)
    this.planTemplates.set(templateKey, solved.template)
    return { envId, plan: solved.plan, rootSiteByEntryKey }
  }

  inspect(plan: ResolvedPlan): PlannedEnvInspection {
    const uniqueSlots = [...new Set(plan.slotsByNode.values())]
    const owned = uniqueSlots.filter(slot => slot.ownerEnvId === plan.envId).length
    const services = [...plan.nodes.values()]
      .filter((node): node is ServicePlanNode => node.kind === 'service')
    return Object.freeze({
      nodeCount: plan.nodes.size,
      ownedSlotCount: owned,
      reusedSlotCount: uniqueSlots.length - owned,
      eagerServiceCount: services.filter(node => node.revision.eager).length,
      selectedRevisions: Object.freeze(Object.fromEntries(plan.choices)),
    })
  }

  explain(
    plan: ResolvedPlan,
    descriptor: EntryDescriptor,
    parent: PlanningParent | undefined,
  ): EntryExplanationSuccess {
    const nodes: ExplainedNode[] = []
    const pathFor = (nodeId: string): string[] => {
      const path = [nodeId]
      const seen = new Set(path)
      let current = plan.explanations.get(nodeId)?.cause
      while (current && current.kind === 'dependency-forked' && !seen.has(current.dependency)) {
        path.push(current.dependency)
        seen.add(current.dependency)
        current = plan.explanations.get(current.dependency)?.cause
      }
      return path
    }
    for (const node of [...plan.nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const explanation = plan.explanations.get(node.id)!
      nodes.push(Object.freeze({
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        disposition: explanation.disposition,
        eager: node.kind === 'service' && node.revision.eager,
        ...(explanation.cause ? { cause: explanation.cause } : {}),
        path: Object.freeze(explanation.disposition === 'inherited' ? [node.id] : pathFor(node.id)),
      }))
    }
    const count = (predicate: (node: ExplainedNode) => boolean) => {
      const selected = nodes.filter(predicate)
      return {
        inherited: selected.filter(node => node.disposition === 'inherited').length,
        new: selected.filter(node => node.disposition === 'new').length,
        forked: selected.filter(node => node.disposition === 'forked').length,
      }
    }
    const services = count(node => node.kind === 'service')
    const inputNodes = nodes.filter(node => node.kind === 'input')
    const bindingNodes = [...plan.nodes.values()]
      .filter(node => node.kind === 'binding')
    const providedInputIds = new Set(
      Object.values(descriptor.parameters)
        .filter((parameter): parameter is Input => parameter.kind === 'input')
        .map(parameter => parameter.id),
    )
    const ownBindingIds = new Set(
      Object.values(descriptor.parameters)
        .filter((parameter): parameter is Binding => parameter.kind === 'binding')
        .map(parameter => parameter.id),
    )
    const bindingsResolved: Record<string, string> = {}
    const bindingsInherited: Record<string, string> = {}
    for (const node of bindingNodes) {
      if (node.kind !== 'binding') continue
      const target = ownBindingIds.has(node.binding.id) ? bindingsResolved : bindingsInherited
      target[node.binding.id] = node.revision.key
    }
    for (const [bindingId, choice] of plan.bindingChoices) {
      if (ownBindingIds.has(bindingId) && !(bindingId in bindingsResolved)) {
        bindingsResolved[bindingId] = choice.revision.key
      }
    }

    return Object.freeze({
      ok: true as const,
      entry: descriptor.id,
      ...(parent ? { parent: parent.id } : {}),
      parameters: Object.freeze({
        inputsProvided: Object.freeze([...providedInputIds].sort()),
        inputsInherited: Object.freeze(
          inputNodes
            .filter(node => node.disposition === 'inherited')
            .map(node => node.label)
            .sort(),
        ),
        bindingsResolved: Object.freeze(bindingsResolved),
        bindingsInherited: Object.freeze(bindingsInherited),
      }),
      services: Object.freeze({
        ...services,
        eagerToStart: nodes.filter(node => node.kind === 'service' && node.eager && node.disposition !== 'inherited').length,
        eagerInherited: nodes.filter(node => node.kind === 'service' && node.eager && node.disposition === 'inherited').length,
      }),
      inputs: Object.freeze({
        inherited: inputNodes.filter(node => node.disposition === 'inherited').length,
        provided: inputNodes.filter(node => node.disposition !== 'inherited').length,
      }),
      synthetic: Object.freeze(count(node => node.kind !== 'service' && node.kind !== 'input')),
      choices: Object.freeze(Object.fromEntries(plan.choices)),
      nodes: Object.freeze(nodes),
      forks: Object.freeze(nodes.filter(node => node.disposition !== 'inherited')),
    })
  }

  activeRevisionKeys(plan?: ResolvedPlan): ReadonlySet<string> {
    if (!plan) return new Set()
    return new Set(
      [...plan.nodes.values()]
        .filter((node): node is ServicePlanNode => node.kind === 'service')
        .map(node => node.revision.key),
    )
  }

  // GraphBuilderHost -------------------------------------------------------

  compiledExact(revision: ServiceRevision): CompiledService {
    return this.compiler.compiledExact(revision)
  }

  familyRevisions(familyId: string): readonly CompiledService[] {
    return this.compiler.familyRevisions(familyId)
  }

  serviceRealm(owner: CompiledService): ResolutionRealm {
    return this.compiler.realmFor(owner)
  }

  registerFamily(family: ServiceFamily): void {
    this.compiler.registerFamily(family)
  }

  registerContract(contract: Contract): void {
    this.compiler.registerContract(contract)
  }

  registerInput(input: Input): void {
    this.compiler.registerInput(input)
  }

  registerBinding(binding: Binding): void {
    this.compiler.registerBinding(binding)
  }

  registerEntry(entry: EntryDescriptor): void {
    this.compiler.registerEntry(entry)
  }

  orderCandidates(
    candidates: readonly CompiledService[],
    order: (revisions: readonly ServiceRevision[]) => readonly ServiceRevision[],
    site: string,
  ): readonly CompiledService[] {
    return this.directory.orderCandidates(candidates, order, site)
  }

  // Internals ---------------------------------------------------------------

  private planTemplateKey(
    parent: PlanningParent | undefined,
    descriptor: EntryDescriptor,
    parameters: ReadonlyMap<string, InputSlot>,
    bindings: ReadonlyMap<string, BindingChoiceSlot>,
    fresh: ScopeTargetSet,
    share: ScopeTargetSet,
    realm: ResolutionRealm,
  ): string {
    const inputShape = [...parameters.keys()].sort().join(',')
    const bindingShape = [...bindings.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, choice]) => `${id}=${choice.revision.key}`)
      .join(',')
    const scopeShape = (targets: ScopeTargetSet): string => [
      ...[...targets.revisionKeys].map(key => `revision:${key}`),
      ...[...targets.familyIds].map(id => `family:${id}`),
    ].sort().join(',')
    // Lineage anchors reach a child through gap Envs whose own graph (and thus
    // signature) never mentions them, yet they decide which revision a
    // lineage-unique family may take below. They are part of the plan shape.
    const anchorShape = [...(parent?.plan.anchors ?? new Map<string, ServiceSlot>()).entries()]
      .map(([familyId, slot]) => `${familyId}=${slot.service.key}`)
      .sort()
      .join(',')
    return [
      parent ? compactDigest(parent.plan.signature) : 'root',
      `lineage=${parent?.plan.lineageKey ?? 'root'}`,
      `anchors=${anchorShape ? compactDigest(anchorShape) : 'none'}`,
      `realm=${realm.id}`,
      entryDefinitionSignature(descriptor),
      `parameters=${inputShape}`,
      `bindings=${bindingShape}`,
      `fresh=${scopeShape(fresh)}`,
      `share=${scopeShape(share)}`,
    ].join('|')
  }

  private solvePlanTemplate(
    input: PlanEntryParameters,
    choices: ReadonlyMap<string, string>,
    budget: { remaining: number },
  ): { readonly template: CachedGraphTemplate; readonly plan: ResolvedPlan } {
    try {
      const graph = new GraphBuilder(
        this,
        input.rootSites,
        input.inputSlots,
        input.bindingChoices,
        choices,
        input.parent,
      ).build()
      const signature = graphSignature(graph, choices)
      const template = Object.freeze({
        graph,
        choices: new Map(choices),
        signature,
        parentSignature: input.parent?.plan.signature,
      })
      return {
        template,
        plan: this.assignSlots(input, graph, choices, signature),
      }
    }
    catch (error) {
      if (!(error instanceof NeedChoice)) throw error
      const failures: SynaError[] = []
      for (const candidate of error.data.candidates) {
        budget.remaining -= 1
        if (budget.remaining < 0) {
          throw new SynaError(
            'PLANNING_BUDGET_EXCEEDED',
            `Planning ${input.lineageKey} exhausted its candidate search budget (${this.searchBudget}); this is a budget limit, not a proof of unsatisfiability.`,
            { site: error.data.site, budget: this.searchBudget },
          )
        }
        const nextChoices = new Map(choices)
        nextChoices.set(error.data.site, candidate.key)
        try {
          return this.solvePlanTemplate(input, nextChoices, budget)
        }
        catch (candidateError) {
          if (!isBacktrackableTopologyError(candidateError)) throw candidateError
          failures.push(candidateError)
        }
      }
      // Every candidate failed the same way at the same place: the failure does
      // not depend on the choice at all (a missing Input deeper in the graph, a
      // share violation elsewhere). Report it under its own code instead of
      // blaming the choice site, so the diagnosis does not depend on whether an
      // unresolved choice site happened to be reached first.
      const distinct = new Set(failures.map(failure => stableJson({ code: failure.code, message: failure.message, details: failure.details })))
      if (failures.length > 0 && distinct.size === 1) throw failures[0]!
      throw new SynaError(
        'UNSATISFIABLE_TOPOLOGY',
        `No candidate can satisfy ${error.data.description} at ${error.data.site}.`,
        {
          site: error.data.site,
          candidates: error.data.candidates.map(candidate => candidate.key),
          failures: failures.map(failure => ({ code: failure.code, message: failure.message, details: failure.details })),
        },
        failures[0] ? { cause: failures[0] } : undefined,
      )
    }
  }

  private assignSlots(
    input: PlanEntryParameters,
    graph: GraphBuildResult,
    choices: ReadonlyMap<string, string>,
    signature: string,
  ): ResolvedPlan {
    const activeServices = [...graph.nodes.values()]
      .filter((node): node is ServicePlanNode => node.kind === 'service')

    this.validateScopeTargets(input.fresh, activeServices, 'fresh', input.envId)
    this.validateScopeTargets(input.share, activeServices, 'share', input.envId)

    const parentPlan = input.parent?.plan
    const anchors = new Map(parentPlan?.anchors ?? [])
    const reusable = new Map<string, ReuseCandidate>()
    const causes = new Map<string, ForkCause>()

    const inputSlotFor = (node: PlanNode): RuntimeSlot | undefined =>
      node.kind === 'input' ? input.inputSlots.get(node.descriptor.id) : undefined

    for (const node of graph.nodes.values()) {
      if (node.kind === 'input') {
        if (input.providedInputIds.has(node.descriptor.id)) {
          causes.set(node.id, { kind: 'input-provided', input: node.descriptor.id })
        }
        continue
      }
      if (!parentPlan) {
        causes.set(node.id, { kind: 'root' })
        continue
      }
      if (node.kind === 'service' && targetSetHas(input.fresh, node.revision)) {
        causes.set(node.id, { kind: 'fresh', target: scopeTargetLabel(input.fresh, node.revision) })
        continue
      }
      const parentNode = parentPlan.nodes.get(node.id)
      if (!parentNode) {
        if (node.kind === 'service' && node.revision.family.uniqueWithin === 'lineage') {
          const anchor = anchors.get(node.revision.family.id)
          if (anchor && anchor.service.key === node.revision.key) {
            reusable.set(node.id, { slot: anchor, viaAnchor: true })
            continue
          }
        }
        causes.set(node.id, { kind: 'not-in-parent' })
        continue
      }
      if (parentNode.kind !== node.kind || parentNode.label !== node.label) {
        causes.set(
          node.id,
          node.kind === 'binding'
            ? { kind: 'binding-changed', binding: node.binding.id }
            : { kind: 'structure-changed' },
        )
        continue
      }
      const parentSlot = parentPlan.slotsByNode.get(node.id)
      if (!parentSlot) {
        causes.set(node.id, { kind: 'not-in-parent' })
        continue
      }
      reusable.set(node.id, { slot: parentSlot, viaAnchor: false })
    }

    if (parentPlan) {
      const reverse = new Map<string, Set<string>>()
      for (const node of graph.nodes.values()) {
        for (const target of node.edges.values()) {
          const dependants = reverse.get(target) ?? new Set<string>()
          dependants.add(node.id)
          reverse.set(target, dependants)
        }
      }

      const mismatch = (nodeId: string): { via: string; dependency: string } | undefined => {
        const node = graph.nodes.get(nodeId)!
        const candidate = reusable.get(nodeId)
        if (!candidate) return undefined
        for (const [edge, targetId] of node.edges) {
          const expected = candidate.slot.requires.get(edge)
          const targetNode = graph.nodes.get(targetId)!
          const current = inputSlotFor(targetNode) ?? reusable.get(targetId)?.slot
          if (!expected || current !== expected) return { via: edge, dependency: targetId }
        }
        return undefined
      }

      const queue = [...reusable.keys()]
      const queued = new Set(queue)
      while (queue.length > 0) {
        const nodeId = queue.shift()!
        queued.delete(nodeId)
        const candidate = reusable.get(nodeId)
        if (!candidate) continue
        const failure = mismatch(nodeId)
        if (!failure) continue
        reusable.delete(nodeId)
        const node = graph.nodes.get(nodeId)!
        causes.set(
          nodeId,
          candidate.viaAnchor && node.kind === 'service'
            ? { kind: 'anchor-dependency-mismatch', family: node.revision.family.id, via: failure.via }
            : { kind: 'dependency-forked', via: failure.via, dependency: failure.dependency },
        )
        for (const dependant of reverse.get(nodeId) ?? []) {
          if (reusable.has(dependant) && !queued.has(dependant)) {
            queue.push(dependant)
            queued.add(dependant)
          }
        }
      }
    }

    const causePath = (nodeId: string): string[] => {
      const path = [nodeId]
      let cause = causes.get(nodeId)
      while (cause && cause.kind === 'dependency-forked' && !path.includes(cause.dependency)) {
        path.push(cause.dependency)
        cause = causes.get(cause.dependency)
      }
      return path
    }

    for (const node of activeServices) {
      if (!targetSetHas(input.share, node.revision)) continue
      if (!reusable.has(node.id)) {
        throw new SynaError(
          'SHARE_CONSTRAINT_FAILED',
          `${node.revision.key} cannot reuse its parent-visible slot in Env ${input.envId}.`,
          {
            revision: node.revision.key,
            env: input.envId,
            cause: causes.get(node.id),
            path: causePath(node.id),
          },
        )
      }
    }

    const slotsByNode = new Map<string, RuntimeSlot>()
    for (const node of graph.nodes.values()) {
      if (node.kind === 'input') {
        slotsByNode.set(node.id, input.inputSlots.get(node.descriptor.id)!)
        continue
      }
      const inherited = reusable.get(node.id)
      if (inherited) {
        slotsByNode.set(node.id, inherited.slot)
        continue
      }
      if (node.kind === 'service') {
        const slot: ServiceSlot = {
          kind: 'service',
          id: this.allocateSlotId(input.envId),
          ownerEnvId: input.envId,
          service: node.revision,
          requires: new Map(),
          state: 'dormant',
          cleanups: [],
          attemptCount: 0,
        }
        slotsByNode.set(node.id, slot)
      }
      else {
        const slot: SyntheticSlot = {
          kind: node.kind,
          id: this.allocateSlotId(input.envId),
          ownerEnvId: input.envId,
          state: 'ready',
          requires: new Map(),
        }
        slotsByNode.set(node.id, slot)
      }
    }

    for (const node of graph.nodes.values()) {
      if (reusable.has(node.id) || node.kind === 'input') continue
      const slot = slotsByNode.get(node.id) as ServiceSlot | SyntheticSlot
      for (const [edge, targetNodeId] of node.edges) {
        slot.requires.set(edge, slotsByNode.get(targetNodeId)!)
      }
    }

    const uniqueByFamily = new Map<string, ServicePlanNode[]>()
    for (const node of activeServices) {
      if (node.revision.family.uniqueWithin !== 'lineage') continue
      const list = uniqueByFamily.get(node.revision.family.id) ?? []
      list.push(node)
      uniqueByFamily.set(node.revision.family.id, list)
    }

    for (const [familyId, nodes] of uniqueByFamily) {
      const slots = nodes.map(node => slotsByNode.get(node.id) as ServiceSlot)
      const distinct = [...new Set(slots)]
      const anchor = anchors.get(familyId)
      if (anchor) {
        const divergent = nodes.filter(node => slotsByNode.get(node.id) !== anchor)
        if (divergent.length > 0) {
          throw new SynaError(
            'LINEAGE_UNIQUENESS_CONFLICT',
            `Lineage-unique Service Family ${familyId} cannot diverge below its anchor ${anchor.service.key} (slot ${anchor.id}).`,
            {
              family: familyId,
              anchorRevision: anchor.service.key,
              anchorSlot: anchor.id,
              attempted: divergent.map(node => ({
                revision: node.revision.key,
                slot: (slotsByNode.get(node.id) as ServiceSlot).id,
                cause: causes.get(node.id),
                path: causePath(node.id),
              })),
            },
          )
        }
      }
      else {
        if (distinct.length > 1) {
          throw new SynaError(
            'LINEAGE_UNIQUENESS_CONFLICT',
            `Lineage-unique Service Family ${familyId} would create multiple slots in one lineage.`,
            { family: familyId, slots: distinct.map(slot => `${slot.service.key}#${slot.id}`) },
          )
        }
        if (distinct[0]) anchors.set(familyId, distinct[0])
      }
    }

    const explanations = new Map<string, NodeExplanation>()
    for (const node of graph.nodes.values()) {
      const cause = causes.get(node.id)
      if (node.kind === 'input') {
        explanations.set(node.id, cause
          ? { disposition: 'new', cause }
          : { disposition: 'inherited', cause: undefined })
        continue
      }
      if (reusable.has(node.id)) {
        explanations.set(node.id, { disposition: 'inherited', cause: undefined })
        continue
      }
      const disposition = cause?.kind === 'root' || cause?.kind === 'not-in-parent' ? 'new' : 'forked'
      explanations.set(node.id, { disposition, cause })
    }

    return {
      nodes: graph.nodes,
      rootNodeBySite: graph.rootNodeBySite,
      slotsByNode,
      rootSites: input.rootSites,
      inputSlots: input.inputSlots,
      bindingChoices: input.bindingChoices,
      choices: new Map(choices),
      anchors,
      explanations,
      signature,
      lineageKey: input.lineageKey,
      envId: input.envId,
      checking: input.checking,
    }
  }

  private validateScopeTargets(
    targets: ScopeTargetSet,
    active: readonly ServicePlanNode[],
    kind: 'fresh' | 'share',
    envId: string,
  ): void {
    const activeKeys = new Set(active.map(node => node.revision.key))
    const activeFamilies = new Set(active.map(node => node.revision.family.id))
    for (const key of targets.revisionKeys) {
      if (!activeKeys.has(key)) {
        throw new SynaError(
          'INACTIVE_REUSE_TARGET',
          `${kind} targets inactive Service Revision ${key}.`,
          { constraint: kind, env: envId, revision: key },
        )
      }
    }
    for (const family of targets.familyIds) {
      if (!activeFamilies.has(family)) {
        throw new SynaError(
          'INACTIVE_REUSE_TARGET',
          `${kind} targets inactive Service Family ${family}.`,
          { constraint: kind, env: envId, family },
        )
      }
    }
  }

  private mergeScopeTargets(
    first: readonly ReuseTarget[] | undefined,
    second: readonly ReuseTarget[] | undefined,
  ): ScopeTargetSet {
    const left = scopeTargetSet(first)
    const right = scopeTargetSet(second)
    const revisionKeys = new Set<string>([...left.revisionKeys, ...right.revisionKeys])
    const familyIds = new Set<string>([...left.familyIds, ...right.familyIds])
    return { revisionKeys, familyIds }
  }

  private prepareInputs<E extends EntryDescriptor<any, any>>(
    envId: string,
    parent: PlanningParent | undefined,
    descriptor: E,
    input: EntryArguments<E>,
  ): {
    readonly slots: ReadonlyMap<string, InputSlot>
    readonly providedIds: ReadonlySet<string>
    readonly missing: readonly string[]
  } {
    const result = new Map(parent?.plan.inputSlots ?? [])
    const providedIds = new Set<string>()
    const missing: string[] = []
    const provided = input as Readonly<Record<string, unknown>>
    for (const [key, parameter] of Object.entries(descriptor.parameters) as [string, Input | Binding][]) {
      if (parameter.kind !== 'input') continue
      this.registerInput(parameter)
      if (!(key in provided)) {
        missing.push(parameter.id)
        continue
      }
      const slot: InputSlot = Object.freeze({
        kind: 'input',
        id: this.allocateSlotId(envId),
        ownerEnvId: envId,
        descriptor: parameter,
        payload: provided[key],
        state: 'ready',
        requires: new Map(),
      })
      result.set(parameter.id, slot)
      providedIds.add(parameter.id)
    }
    return { slots: result, providedIds, missing }
  }

  private prepareBindings<E extends EntryDescriptor<any, any>>(
    envId: string,
    parent: PlanningParent | undefined,
    descriptor: E,
    input: EntryArguments<E>,
  ): {
    readonly choices: ReadonlyMap<string, BindingChoiceSlot>
    readonly changedIds: ReadonlySet<string>
    readonly missing: readonly string[]
  } {
    const result = new Map(parent?.plan.bindingChoices ?? [])
    const changedIds = new Set<string>()
    const missing: string[] = []
    const assignments = input as Readonly<Record<string, unknown>>
    for (const [key, parameter] of Object.entries(descriptor.parameters) as [string, Input | Binding][]) {
      if (parameter.kind !== 'binding') continue
      this.registerBinding(parameter)
      if (!(key in assignments)) {
        missing.push(parameter.id)
        continue
      }
      const revision = this.resolveBindingAssignment(
        parameter,
        assignments[key] as BindingAssignment<any>,
        parent?.plan,
      )
      const inherited = result.get(parameter.id)
      // Binding equality is nominal and decidable; selecting the same exact
      // revision is deliberately a no-op, unlike re-providing an Input.
      if (inherited?.revision.key === revision.key) continue
      changedIds.add(parameter.id)
      result.set(parameter.id, Object.freeze({
        id: this.allocateChoiceId(envId),
        ownerEnvId: envId,
        binding: parameter,
        revision,
      }))
    }
    return { choices: result, changedIds, missing }
  }

  private resolveBindingAssignment(
    binding: Binding,
    assignment: BindingAssignment<any>,
    parentPlan?: ResolvedPlan,
  ): CompiledService {
    let revision: CompiledService
    if (isServiceRevision(assignment)) {
      const compiled = this.compiler.compiledExact(assignment)
      if (!compiled.admitted) {
        throw new SynaError(
          'MISSING_SERVICE',
          `${compiled.key} is not admitted by this Runtime and cannot be assigned to Binding ${binding.id}.`,
          { binding: binding.id, revision: compiled.key },
        )
      }
      revision = compiled
    }
    else {
      if (typeof assignment !== 'object' || assignment === null || assignment.kind !== 'persistent-implementation-ref') {
        throw new SynaError('INVALID_DESCRIPTOR', `Invalid assignment for Binding ${binding.id}.`, { descriptor: binding.id, problem: 'invalid-assignment' })
      }
      if (assignment.contractId !== binding.contract.id) {
        throw new SynaError(
          'INCOMPATIBLE_IMPLEMENTATION',
          `Implementation reference for ${assignment.contractId} cannot satisfy Binding ${binding.id} (${binding.contract.id}).`,
          { binding: binding.id, contract: binding.contract.id, reference: assignment.contractId },
        )
      }
      const site = `binding:${binding.id}`
      const familyId = this.directory.familyOf(assignment, site)
      const candidates = this.directory
        .candidatesForFamily(familyId)
        .filter(candidate => satisfiesVersion(candidate.version, assignment.version))
        .filter(candidate => providesContract(candidate, binding.contract))
      if (candidates.length === 0) {
        throw new SynaError(
          'MISSING_IMPLEMENTATION',
          `No admitted ${familyId} revision satisfies ${assignment.version} and ${binding.contract.id}.`,
          {
            binding: binding.id,
            implementation: familyId,
            version: assignment.version,
            available: this.directory.revisions(familyId),
          },
        )
      }
      revision = this.orderCandidates(
        candidates,
        revisions => this.policy.orderVersionCandidates(
          candidates[0]!.family,
          revisions,
          new PolicyContext(site, this.activeRevisionKeys(parentPlan)),
        ),
        site,
      )[0]!
    }
    if (!providesContract(revision, binding.contract)) {
      throw new SynaError(
        'INCOMPATIBLE_IMPLEMENTATION',
        `${revision.key} does not provide Contract ${binding.contract.id}.`,
        { binding: binding.id, revision: revision.key },
      )
    }
    return revision
  }

  /** What a cold plan registers first for each root site of the Entry (the graph builder's first step per dependency kind). */
  private registerRootSiteDescriptors(rootSites: readonly RootSite[]): void {
    for (const root of rootSites) {
      const dependency = unwrapDependency(root.dependency)
      switch (dependency.kind) {
        case 'service-revision':
          this.compiledExact(dependency)
          break
        case 'service-range':
          this.registerFamily(dependency.family)
          break
        case 'contract':
          this.registerContract(dependency)
          break
        case 'auto-implementation':
        case 'all-implementations':
          this.registerContract(dependency.contract)
          break
        case 'entry':
          this.registerEntry(dependency)
          break
        default:
          break // inputs and bindings were prepared before the cache lookup
      }
    }
  }

  private allocateSlotId(envId: string): string {
    return isCheckEnvId(envId) ? `check-slot-${this.nextCheckSlotNumber++}` : `slot-${this.nextSlotNumber++}`
  }

  private allocateChoiceId(envId: string): string {
    return isCheckEnvId(envId) ? `check-choice-${this.nextCheckSlotNumber++}` : `choice-${this.nextSlotNumber++}`
  }
}

const isCheckEnvId = (envId: string): boolean => envId.startsWith('check-')

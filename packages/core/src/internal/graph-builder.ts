import type {
  Binding,
  Contract,
  Input,
  RuntimePolicy,
  RuntimePolicyContext,
  EntryDescriptor,
  ServiceFamily,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { satisfiesVersion } from '../semver.js'
import type {
  AllPlanNode,
  BindingChoiceSlot,
  BindingPlanNode,
  AnchoredEntryPlanNode,
  CompiledService,
  EnvPlanView,
  GraphBuildResult,
  InputSlot,
  PlanNode,
  ResolutionRealm,
  RootSite,
  ServicePlanNode,
} from './runtime-model.js'
import { NeedChoice, PolicyContext } from './runtime-model.js'
import { compareRevisionIdentity, providesContract, unwrapDependency } from './identity.js'
import { realmAllows } from './resolution-realm.js'

export interface GraphBuilderHost {
  readonly admitted: readonly CompiledService[]
  readonly policy: RuntimePolicy

  compiledExact(revision: ServiceRevision): CompiledService
  familyRevisions(familyId: string): readonly CompiledService[]
  serviceRealm(owner: CompiledService): ResolutionRealm
  registerFamily(family: ServiceFamily): void
  registerContract(contract: Contract): void
  registerInput(input: Input): void
  registerBinding(binding: Binding): void
  registerEntry(entry: EntryDescriptor): void
  orderCandidates(
    candidates: readonly CompiledService[],
    order: (revisions: readonly ServiceRevision[]) => readonly ServiceRevision[],
    site: string,
  ): readonly CompiledService[]
}

/**
 * Lowers Entry roots and Service manifests into an exact nominal node graph.
 * Node ids are stable across Envs (they never contain Env or slot ids), which
 * is what makes parent-visible reuse and plan-template caching possible.
 */
export class GraphBuilder {
  private readonly nodes = new Map<string, PlanNode>()
  private readonly rootNodeBySite = new Map<string, string>()
  private readonly parentActiveRevisionKeys: ReadonlySet<string>

  constructor(
    private readonly host: GraphBuilderHost,
    private readonly rootSites: readonly RootSite[],
    private readonly inputSlots: ReadonlyMap<string, InputSlot>,
    private readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>,
    private readonly choices: ReadonlyMap<string, string>,
    parent?: EnvPlanView,
  ) {
    this.parentActiveRevisionKeys = new Set(
      parent
        ? [...parent.plan.nodes.values()]
          .filter((node): node is ServicePlanNode => node.kind === 'service')
          .map(node => node.revision.key)
        : [],
    )
  }

  build(): GraphBuildResult {
    for (const root of this.rootSites) {
      const nodeId = this.resolveDependency(root.dependency, root.id, root.realm)
      this.rootNodeBySite.set(root.id, nodeId)
    }
    return { nodes: this.nodes, rootNodeBySite: this.rootNodeBySite }
  }

  private resolutionContext(dependencySite: string): RuntimePolicyContext {
    return new PolicyContext(dependencySite, this.parentActiveRevisionKeys)
  }

  private implementationCandidates(contract: Contract): readonly CompiledService[] {
    this.host.registerContract(contract)
    return this.host.admitted.filter(revision => providesContract(revision, contract))
  }

  private resolveDependency(
    dependencyInput: RootSite['dependency'],
    site: string,
    realm: ResolutionRealm,
    ownerNodeId?: string,
  ): string {
    const dependency = unwrapDependency(dependencyInput)

    switch (dependency.kind) {
      case 'service-revision': {
        const compiled = this.host.compiledExact(dependency)
        if (!realmAllows(realm, compiled.key, compiled.admitted)) {
          throw new SynaError(
            'MISSING_SERVICE',
            `${compiled.key} is not admitted by this Runtime and ${realm.kind === 'public' ? 'public Entries have no private authority' : `is outside the private realm of ${realm.ownerKey}`} (${site}).`,
            { revision: compiled.key, site, realm: realm.id },
          )
        }
        return this.resolveService(compiled)
      }

      case 'service-range': {
        this.host.registerFamily(dependency.family)
        const visible = this.host.familyRevisions(dependency.family.id)
          .filter(revision => realmAllows(realm, revision.key, revision.admitted))
          .filter(revision => satisfiesVersion(revision.version, dependency.range))
        if (visible.length === 0) {
          throw new SynaError(
            'MISSING_SERVICE',
            `No revision of ${dependency.family.id} visible at ${site} satisfies ${dependency.range}.`,
            { family: dependency.family.id, range: dependency.range, site, realm: realm.id },
          )
        }
        // A range loads the Contract view of its origin, so only revisions that
        // provide every Contract of the origin can stand in for it.
        const required = dependency.requiredContractIds ?? []
        const candidates = visible.filter(revision => required.every(id => providesContract(revision, { id })))
        if (candidates.length === 0) {
          throw new SynaError(
            'INCOMPATIBLE_IMPLEMENTATION',
            `No revision of ${dependency.family.id} visible at ${site} satisfies ${dependency.range} and provides the Contracts of ${dependency.origin.key} (${required.join(', ')}).`,
            {
              family: dependency.family.id,
              range: dependency.range,
              site,
              realm: realm.id,
              origin: dependency.origin.key,
              required,
              candidates: visible.map(revision => ({ revision: revision.key, provides: revision.provides.map(contract => contract.id) })),
            },
          )
        }
        const ordered = this.host.orderCandidates(
          candidates,
          revisions => this.host.policy.orderVersionCandidates(
            dependency.family,
            revisions,
            this.resolutionContext(site),
          ),
          site,
        )
        return this.resolveChosenRevision(site, ordered, `${dependency.family.id}@${dependency.range}`)
      }

      case 'input': {
        this.host.registerInput(dependency)
        if (!this.inputSlots.has(dependency.id)) {
          throw new SynaError(
            'MISSING_INPUT',
            `Input ${dependency.id} is required at ${site} but is not provided by this Env lineage.`,
            { input: dependency.id, site, missing: [dependency.id] },
          )
        }
        const nodeId = `input:${dependency.id}`
        if (!this.nodes.has(nodeId)) {
          this.nodes.set(nodeId, {
            id: nodeId,
            kind: 'input',
            label: dependency.id,
            edges: new Map(),
            descriptor: dependency,
          })
        }
        return nodeId
      }

      case 'binding': {
        this.host.registerBinding(dependency)
        const choice = this.bindingChoices.get(dependency.id)
        if (!choice) {
          throw new SynaError(
            'MISSING_BINDING',
            `Binding ${dependency.id} is required at ${site} but has no choice in this Env lineage.`,
            { binding: dependency.id, site, missing: [dependency.id] },
          )
        }
        const nodeId = `binding:${dependency.id}`
        const existing = this.nodes.get(nodeId)
        if (existing) return existing.id
        const node: BindingPlanNode = {
          id: nodeId,
          kind: 'binding',
          label: `${dependency.id}->${choice.revision.key}`,
          edges: new Map(),
          binding: dependency,
          revision: choice.revision,
        }
        this.nodes.set(nodeId, node)
        node.edges.set('target', this.resolveService(choice.revision))
        return nodeId
      }

      case 'entry': {
        this.host.registerEntry(dependency)
        const nodeId = `entry:${site}:${dependency.id}`
        const existing = this.nodes.get(nodeId)
        if (existing) return existing.id
        const owner = ownerNodeId ? this.nodes.get(ownerNodeId) : undefined
        const entryRealm = owner?.kind === 'service'
          ? this.host.serviceRealm(owner.revision)
          : realm
        const node: AnchoredEntryPlanNode = {
          id: nodeId,
          kind: 'entry',
          label: `${dependency.id}@${site}`,
          edges: new Map(),
          entry: dependency,
          dependencySite: site,
          realm: entryRealm,
          ...(ownerNodeId ? { anchorNodeId: ownerNodeId } : {}),
        }
        if (ownerNodeId) node.edges.set('anchor', ownerNodeId)
        this.nodes.set(nodeId, node)
        return nodeId
      }

      case 'contract': {
        const candidates = this.implementationCandidates(dependency)
        if (candidates.length === 0) {
          throw new SynaError(
            'MISSING_IMPLEMENTATION',
            `No admitted Service implements Contract ${dependency.id}.`,
            { contract: dependency.id, site },
          )
        }
        const families = new Set(candidates.map(candidate => candidate.family.id))
        if (families.size > 1) {
          throw new SynaError(
            'AMBIGUOUS_IMPLEMENTATION',
            `Contract ${dependency.id} has multiple implementation families at ${site}; use auto(), a Binding, or an exact Service.`,
            { contract: dependency.id, site, families: [...families].sort() },
          )
        }
        const family = candidates[0]!.family
        const ordered = this.host.orderCandidates(
          candidates,
          revisions => this.host.policy.orderVersionCandidates(
            family,
            revisions,
            this.resolutionContext(site),
          ),
          site,
        )
        return this.resolveChosenRevision(site, ordered, `contract(${dependency.id})`)
      }

      case 'auto-implementation': {
        const candidates = this.implementationCandidates(dependency.contract)
        if (candidates.length === 0) {
          throw new SynaError(
            'MISSING_IMPLEMENTATION',
            `No admitted Service implements Contract ${dependency.contract.id}.`,
            { contract: dependency.contract.id, site },
          )
        }
        const ordered = this.host.orderCandidates(
          candidates,
          revisions => this.host.policy.orderAutoCandidates(
            dependency.contract,
            revisions,
            this.resolutionContext(site),
          ),
          site,
        )
        return this.resolveChosenRevision(site, ordered, `auto(${dependency.contract.id})`)
      }

      case 'all-implementations': {
        const candidates = [...this.implementationCandidates(dependency.contract)]
          .sort(compareRevisionIdentity)
        const nodeId = `all:${dependency.contract.id}`
        const existing = this.nodes.get(nodeId)
        if (existing) return existing.id
        const node: AllPlanNode = {
          id: nodeId,
          kind: 'all',
          label: `${dependency.contract.id}[${candidates.map(item => item.key).join(',')}]`,
          edges: new Map(),
          contract: dependency.contract,
          candidates,
        }
        this.nodes.set(nodeId, node)
        for (const candidate of candidates) {
          node.edges.set(candidate.key, this.resolveService(candidate))
        }
        return nodeId
      }

      default:
        throw new SynaError(
          'INVALID_DESCRIPTOR',
          `Unknown dependency descriptor at ${site}.`,
          { descriptor: 'Dependency', problem: 'unknown-kind', site },
        )
    }
  }

  private resolveChosenRevision(
    site: string,
    candidates: readonly CompiledService[],
    description: string,
  ): string {
    const selectedKey = this.choices.get(site)
    if (selectedKey) {
      const selected = candidates.find(candidate => candidate.key === selectedKey)
      if (!selected) {
        throw new SynaError(
          'INVALID_INHERITED_CHOICE',
          `The inherited resolution ${selectedKey} is no longer valid at ${site}.`,
          { site, selectedKey, candidates: candidates.map(candidate => candidate.key) },
        )
      }
      return this.resolveService(selected)
    }
    throw new NeedChoice({ site, candidates, description })
  }

  private resolveService(revision: CompiledService): string {
    const nodeId = `service:${revision.key}`
    const existing = this.nodes.get(nodeId)
    if (existing) return existing.id

    const node: ServicePlanNode = {
      id: nodeId,
      kind: 'service',
      label: revision.key,
      edges: new Map(),
      revision,
    }
    this.nodes.set(nodeId, node)

    const realm = this.host.serviceRealm(revision)
    // Sites are resolved in key order, not insertion order: the plan of a closed
    // definition set must not depend on how a `requires` literal was written.
    for (const [key, dependency] of Object.entries(revision.requires).sort(([a], [b]) => a.localeCompare(b))) {
      const site = `service:${revision.key}/dependency:${key}`
      node.edges.set(key, this.resolveDependency(dependency, site, realm, nodeId))
    }
    return nodeId
  }
}

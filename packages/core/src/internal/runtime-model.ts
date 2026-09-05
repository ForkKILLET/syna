import type {
  Awaitable,
  Binding,
  CandidateRef,
  Contract,
  Dependency,
  EntryDescriptor,
  Input,
  ServiceRevision,
} from '../descriptors.js'
import type { LabeledGraphNode } from '../graph.js'

export type EnvState = 'activating' | 'ready' | 'disposing' | 'disposed'
export type ServiceSlotState =
  | 'dormant'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'disposing'
  | 'disposed'

export type NodeKind = 'service' | 'input' | 'binding' | 'selector' | 'all' | 'entry'

export type ResolutionRealm =
  | { readonly kind: 'public'; readonly id: 'public' }
  | { readonly kind: 'private-entry'; readonly id: string }

export interface RootSite {
  readonly id: string
  readonly entryId: string
  readonly key: string
  readonly dependency: Dependency
  readonly realm: ResolutionRealm
}

export interface SlotOwnerEnv {
  readonly id: string
  readonly state: EnvState
  readonly abortController: AbortController
}

export interface InputSlot {
  readonly kind: 'input'
  readonly id: string
  readonly ownerEnvId: string
  readonly descriptor: Input
  readonly payload: unknown
  readonly state: 'ready'
  readonly requires: ReadonlyMap<string, RuntimeSlot>
}

export interface BindingChoiceSlot {
  readonly id: string
  readonly ownerEnvId: string
  readonly binding: Binding
  readonly revision: ServiceRevision
}

export interface SyntheticSlot {
  readonly kind: 'binding' | 'selector' | 'all' | 'entry'
  readonly id: string
  readonly ownerEnvId: string
  readonly state: 'ready'
  readonly requires: Map<string, RuntimeSlot>
  value?: unknown
}

export interface ServiceSlot {
  readonly kind: 'service'
  readonly id: string
  readonly ownerEnvId: string
  readonly revision: ServiceRevision
  readonly requires: Map<string, RuntimeSlot>
  ownerEnv?: SlotOwnerEnv
  state: ServiceSlotState
  instance?: unknown
  error?: unknown
  starting?: Promise<unknown>
  cleanups: Array<() => Awaitable<void>>
  completionOrder?: number
  attempts: number
  failedAt?: number
  recovery?: Promise<unknown>
  generation: number
}

export type RuntimeSlot = InputSlot | SyntheticSlot | ServiceSlot

export interface BasePlanNode extends LabeledGraphNode {
  readonly kind: NodeKind
  readonly edges: Map<string, string>
}

export interface ServicePlanNode extends BasePlanNode {
  readonly kind: 'service'
  readonly revision: ServiceRevision
}

export interface InputPlanNode extends BasePlanNode {
  readonly kind: 'input'
  readonly descriptor: Input
}

export interface BindingPlanNode extends BasePlanNode {
  readonly kind: 'binding'
  readonly binding: Binding
  readonly revision: ServiceRevision
}

/** Candidate worlds are not inserted into the current Env. */
export interface SelectorPlanNode extends BasePlanNode {
  readonly kind: 'selector'
  readonly contract: Contract
  readonly candidates: readonly ServiceRevision[]
  readonly dependencySite: string
  readonly anchorNodeId?: string
}

/** Every candidate is a real dependency in the current Env. */
export interface AllPlanNode extends BasePlanNode {
  readonly kind: 'all'
  readonly contract: Contract
  readonly candidates: readonly ServiceRevision[]
}

export interface BoundEntryPlanNode extends BasePlanNode {
  readonly kind: 'entry'
  readonly entry: EntryDescriptor
  readonly dependencySite: string
  readonly anchorNodeId?: string
  readonly realm: ResolutionRealm
}

export type PlanNode =
  | ServicePlanNode
  | InputPlanNode
  | BindingPlanNode
  | SelectorPlanNode
  | AllPlanNode
  | BoundEntryPlanNode

export interface ResolvedPlan {
  readonly nodes: Map<string, PlanNode>
  readonly rootNodeBySite: Map<string, string>
  readonly slotsByNode: Map<string, RuntimeSlot>
  readonly rootSites: readonly RootSite[]
  readonly inputSlots: ReadonlyMap<string, InputSlot>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly choices: ReadonlyMap<string, string>
  readonly anchors: ReadonlyMap<string, ServiceSlot>
  readonly signature: string
  readonly lineageKey: string
  readonly envId: string
  readonly checking: boolean
}

export interface EnvPlanView {
  readonly plan: ResolvedPlan
  readonly parent: EnvPlanView | undefined
}

export interface NeedChoiceData {
  readonly site: string
  readonly candidates: readonly ServiceRevision[]
  readonly description: string
}

export class NeedChoice extends Error {
  readonly data: NeedChoiceData
  constructor(data: NeedChoiceData) {
    super(`A resolution choice is required at ${data.site}.`)
    this.name = 'NeedChoice'
    this.data = data
  }
}

export interface GraphBuildResult {
  readonly nodes: Map<string, PlanNode>
  readonly rootNodeBySite: Map<string, string>
}

export interface ScopeTargetSet {
  readonly revisionKeys: ReadonlySet<string>
  readonly familyIds: ReadonlySet<string>
}

export interface PlanEntryParameters {
  readonly envId: string
  readonly checking: boolean
  readonly realm: ResolutionRealm
  readonly lineageKey: string
  readonly parent?: EnvPlanView
  readonly rootSites: readonly RootSite[]
  readonly inputSlots: ReadonlyMap<string, InputSlot>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly inheritedChoices: ReadonlyMap<string, string>
  readonly fresh: ScopeTargetSet
  readonly share: ScopeTargetSet
}

export interface InternalCandidateRef extends CandidateRef<any> {
  readonly sourceSlotId: string
  readonly revisionKey: string
}


export interface MaterializationFrame {
  readonly slot: ServiceSlot
  readonly strongLoads: Set<Promise<unknown>>
  active: boolean
}

export interface DisposableError {
  readonly slot: string
  readonly error: unknown
}

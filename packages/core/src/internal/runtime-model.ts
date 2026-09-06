import type {
  Awaitable,
  Binding,
  CandidateRef,
  Contract,
  Dependency,
  DescriptorMetadata,
  EntryDescriptor,
  ForkCause,
  Input,
  NormalizedServiceFailurePolicy,
  RuntimePolicyContext,
  ServiceFamily,
  ServiceRevision,
} from '../descriptors.js'
import type { LabeledGraphNode } from '../graph.js'

/** The context handed to Runtime policies: the dependency site being resolved and the parent lineage's active revisions. */
export class PolicyContext implements RuntimePolicyContext {
  constructor(
    readonly dependencySite: string,
    readonly parentActiveRevisionKeys: ReadonlySet<string>,
  ) {}
}

export type EnvState = 'activating' | 'ready' | 'disposing' | 'disposed'

export type ServiceSlotState =
  | 'dormant'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'disposing'
  | 'disposed'
  /** A timed-out setup attempt never settled before disposal finished. */
  | 'abandoned'

export type NodeKind = 'service' | 'input' | 'binding' | 'all' | 'entry'

/**
 * Internal executable record for one nominal Service revision. Public code
 * only ever sees the `source` descriptor; an override replaces the executable
 * half without creating a second public identity.
 */
export interface CompiledService {
  readonly key: string
  readonly family: ServiceFamily
  readonly version: string
  readonly source: ServiceRevision
  readonly provides: readonly Contract[]
  readonly eager: boolean
  readonly requires: DependencyMap
  readonly setup: ServiceRevision['setup']
  readonly failure: NormalizedServiceFailurePolicy
  readonly setupDeadlineMs: number | undefined
  readonly metadata: Readonly<DescriptorMetadata>
  readonly overriddenBy: ServiceRevision | undefined
  readonly admitted: boolean
}

type DependencyMap = Readonly<Record<string, Dependency>>

/** Authority under which an Entry's roots are resolved. */
export type ResolutionRealm =
  | { readonly kind: 'public'; readonly id: 'public' }
  | {
      readonly kind: 'private-entry'
      readonly id: string
      readonly ownerKey: string
      /** Exact revision keys visible to this realm in addition to public admission. */
      readonly closureKeys: ReadonlySet<string>
    }

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
  readonly revision: CompiledService
}

export interface SyntheticSlot {
  readonly kind: 'binding' | 'all' | 'entry'
  readonly id: string
  readonly ownerEnvId: string
  readonly state: 'ready'
  readonly requires: Map<string, RuntimeSlot>
  value?: unknown
}

export interface PendingLoad {
  readonly target: ServiceSlot
  readonly since: number
}

/** One actual execution of `setup()` for a slot. Waiters join it; it never runs concurrently with another attempt of the same slot. */
export interface SetupAttempt {
  readonly id: number
  readonly slot: ServiceSlot
  readonly startedAt: number
  /**
   * `timed-out`: the deadline passed while the raw setup Promise was pending.
   * `abandoned`: the owner Env closed while it was pending. Both keep the
   * attempt alive as `slot.unsettledAttempt` until the raw Promise settles.
   */
  state: 'running' | 'succeeded' | 'failed' | 'timed-out' | 'abandoned'
  readonly cleanups: Array<() => Awaitable<void>>
  readonly pendingLoads: Map<number, PendingLoad>
  /** True once the user's setup Promise settled (resolved or rejected), however late. */
  rawSettled: boolean
  /** Resolves once the raw setup Promise settled and any orphaned resources were cleaned. */
  readonly settled: Promise<void>
  resolveSettled: () => void
  /** Resolves when disposal gives up waiting for the raw Promise; ends the attempt's race early. */
  readonly abandoned: Promise<void>
  abandon: () => void
}

export interface ServiceSlot {
  readonly kind: 'service'
  readonly id: string
  readonly ownerEnvId: string
  readonly service: CompiledService
  readonly requires: Map<string, RuntimeSlot>
  ownerEnv?: SlotOwnerEnv
  state: ServiceSlotState
  instance?: unknown
  error?: unknown
  failedAt?: number
  /** The attempt currently running, if any. */
  attempt?: SetupAttempt
  /** Result promise of the current or last setup sequence; waiters join it. */
  sequence?: Promise<unknown>
  /** A timed-out or abandoned attempt whose raw Promise has not settled yet. Blocks new attempts. */
  unsettledAttempt?: SetupAttempt
  /**
   * A rollback (attempt cleanup or late-settlement cleanup) of this slot failed:
   * resources it acquired are outside Syna control. Permanent — no policy may
   * start another attempt that would stack on top of them.
   */
  rollbackFailed?: boolean
  recovery?: Promise<unknown>
  cleanups: Array<() => Awaitable<void>>
  completionOrder?: number
  attemptCount: number
}

export type RuntimeSlot = InputSlot | SyntheticSlot | ServiceSlot

export interface BasePlanNode extends LabeledGraphNode {
  readonly kind: NodeKind
  readonly edges: Map<string, string>
}

export interface ServicePlanNode extends BasePlanNode {
  readonly kind: 'service'
  readonly revision: CompiledService
}

export interface InputPlanNode extends BasePlanNode {
  readonly kind: 'input'
  readonly descriptor: Input
}

export interface BindingPlanNode extends BasePlanNode {
  readonly kind: 'binding'
  readonly binding: Binding
  readonly revision: CompiledService
}

/** Every candidate is a real dependency in the current Env. */
export interface AllPlanNode extends BasePlanNode {
  readonly kind: 'all'
  readonly contract: Contract
  readonly candidates: readonly CompiledService[]
}

export interface AnchoredEntryPlanNode extends BasePlanNode {
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
  | AllPlanNode
  | AnchoredEntryPlanNode

export interface NodeExplanation {
  readonly disposition: 'inherited' | 'new' | 'forked'
  readonly cause: ForkCause | undefined
}

export interface ResolvedPlan {
  readonly nodes: Map<string, PlanNode>
  readonly rootNodeBySite: Map<string, string>
  readonly slotsByNode: Map<string, RuntimeSlot>
  readonly rootSites: readonly RootSite[]
  readonly inputSlots: ReadonlyMap<string, InputSlot>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly choices: ReadonlyMap<string, string>
  /** Lineage-unique family → anchored slot (persists through Envs that do not use the family). */
  readonly anchors: ReadonlyMap<string, ServiceSlot>
  readonly explanations: ReadonlyMap<string, NodeExplanation>
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
  readonly candidates: readonly CompiledService[]
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
  readonly providedInputIds: ReadonlySet<string>
  readonly bindingChoices: ReadonlyMap<string, BindingChoiceSlot>
  readonly changedBindingIds: ReadonlySet<string>
  readonly inheritedChoices: ReadonlyMap<string, string>
  readonly fresh: ScopeTargetSet
  readonly share: ScopeTargetSet
}

export interface InternalCandidateRef extends CandidateRef<any> {
  readonly sourceSlotId: string
  readonly revisionKey: string
}

export interface DisposableError {
  readonly slot: string
  readonly error: unknown
}

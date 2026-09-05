import type { DiagnosticCode, SynaErrorCode } from './errors.js'
import type { OpaqueInstance } from './opaque.js'

export type Awaitable<T> = T | PromiseLike<T>

/** Uniqueness constraints are relative to an Env lineage, never a process-global scope. */
export type UniquenessPolicy = 'none' | 'lineage'

export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly MetadataValue[]
  | { readonly [key: string]: MetadataValue }

export interface DescriptorMetadata {
  readonly displayName?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly data?: Readonly<Record<string, MetadataValue>>
}

/** The package.json fields consumed by definePackage(). Extra fields are allowed structurally. */
export interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly syna?: {
    readonly id?: string
    readonly metadata?: DescriptorMetadata
  }
}

/** Normalized package identity captured by descriptors created from one package scope. */
export interface PackageDescriptor {
  readonly name: string
  readonly id: string
  readonly version: string
  readonly metadata: Readonly<DescriptorMetadata>
}

export interface DefinitionOptions {
  /** Independent descriptor generation. It is deliberately not derived from package semver. */
  readonly apiVersion?: number
  readonly metadata?: DescriptorMetadata
}

/** Select exactly one implementation using the Runtime's explicit policy. */
export interface AutoImplementation<C extends Contract<any> = Contract<any>> {
  readonly kind: 'auto-implementation'
  readonly contract: C
}

/**
 * Enumerate implementations as separately planned child worlds.
 * @deprecated Minimal compatibility surface; prefer `Contract.all` or an explicit Entry.
 */
export interface ImplementationSelectorDependency<
  C extends Contract<any> = Contract<any>,
> {
  readonly kind: 'implementation-selector'
  readonly contract: C
}

/** Require all admitted implementations to coexist in the current Env topology. */
export interface AllImplementations<C extends Contract<any> = Contract<any>> {
  readonly kind: 'all-implementations'
  readonly contract: C
}

/**
 * A nominal capability specification. A naked Contract in `requires` is strict:
 * it succeeds only when one implementation family is unambiguous. `auto(C)` opts
 * into the Runtime's explicit implementation policy.
 */
export interface Contract<Api = unknown> {
  readonly kind: 'contract'
  readonly id: string
  readonly apiVersion: number
  readonly metadata: Readonly<DescriptorMetadata>
  /** @deprecated Compatibility only. */
  readonly selector: ImplementationSelectorDependency<Contract<Api>>
  readonly all: AllImplementations<Contract<Api>>
  readonly __api?: Api
}

export type ContractApi<C> = C extends Contract<infer Api> ? Api : never

/** A typed fact supplied externally when an Entry creates an Env. */
export interface Input<ValueType = unknown> {
  readonly kind: 'input'
  readonly id: string
  readonly apiVersion: number
  readonly metadata: Readonly<DescriptorMetadata>
  readonly __value?: ValueType
}

export type InputType<I> = I extends Input<infer T> ? T : never

/** JSON-safe implementation preference; never an Env-local slot reference. */
export interface PersistentImplementationRef<
  C extends Contract<any> = Contract<any>,
> {
  readonly kind: 'persistent-implementation-ref'
  readonly contractId: string
  readonly implementationId: string
  readonly version: string
  readonly __contract?: C
}

/** Stable identity shared by installed revisions of one implementation. */
export interface ServiceFamily<PublicApi = unknown> {
  readonly kind: 'service-family'
  readonly id: string
  readonly uniqueWithin: UniquenessPolicy
  readonly metadata: Readonly<DescriptorMetadata>
  readonly __publicApi?: PublicApi
}

export type ServiceFamilyApi<F> =
  F extends ServiceFamily<infer Api> ? Api : never

/** Choose an admitted compatible revision of one Service Family. */
export interface ServiceRange<F extends ServiceFamily<any> = ServiceFamily<any>> {
  readonly kind: 'service-range'
  readonly family: F
  readonly range: string
}

/** Defers descriptor lookup so JavaScript modules can declare structural cycles. */
export interface ForwardDependency<D = Dependency> {
  readonly kind: 'forward-dependency'
  readonly get: () => D
}

/** A stable business-level implementation choice inherited through Env descendants. */
export interface Binding<C extends Contract<any> = Contract<any>> {
  readonly kind: 'binding'
  readonly id: string
  readonly apiVersion: number
  readonly contract: C
  readonly metadata: Readonly<DescriptorMetadata>

  to<S extends ServiceRevision<any>>(
    service: ServiceInstance<S> extends ContractApi<C> ? S : never,
    version?: string,
  ): PersistentImplementationRef<C>

  parse(input: unknown): PersistentImplementationRef<C>
}

/** Retry is opt-in because setup may have externally visible side effects. */
export type FailureAfterExhaustion = 'sticky' | 'retry-on-next-load'

/**
 * Service setup failure handling. A setup sequence may contain several
 * attempts; after that sequence is exhausted, the slot is either sticky or
 * may start a fresh sequence on a later load().
 */
export type ServiceFailurePolicy =
  | 'sticky'
  | {
      /** Total attempts in one materialization sequence, including the first. */
      readonly attempts?: number
      /** Delay between attempts in the same sequence. */
      readonly delayMs?: number
      readonly afterExhaustion?: FailureAfterExhaustion
      /** Minimum delay before a future load may start another sequence. */
      readonly cooldownMs?: number
    }

export interface NormalizedServiceFailurePolicy {
  readonly attempts: number
  readonly delayMs: number
  readonly afterExhaustion: FailureAfterExhaustion
  readonly cooldownMs: number
}

/** A dependency-bound Entry capability; invoking it creates a child of the Service slot owner. */
export interface BoundEntry<E extends EntryDescriptor<any, any>> {
  enter(...args: EntryArguments<E>): Promise<EnvHandle<E['requires']>>
  run<Result>(...args: EntryRunArguments<E, Result>): Promise<Result>
  check(...args: EntryArguments<E>): Promise<EntryCheck>
  explain(...args: EntryArguments<E>): Promise<EntryExplanation>
}

/** Every descriptor accepted in a Service or Entry `requires` map. */
export type Dependency =
  | ServiceRevision<any>
  | ServiceRange<any>
  | Contract<any>
  | Input<any>
  | Binding<any>
  | AutoImplementation<any>
  | ImplementationSelectorDependency<any>
  | AllImplementations<any>
  | EntryDescriptor<any, any>
  | ForwardDependency<any>

export type DependencyMap = Readonly<Record<string, Dependency>>

export type UnwrapForward<D> =
  D extends ForwardDependency<infer Inner> ? UnwrapForward<Inner> : D

export type DependencyOutput<D> =
  UnwrapForward<D> extends ServiceRevision<infer Instance>
    ? Instance
    : UnwrapForward<D> extends ServiceRange<infer Family>
      ? ServiceFamilyApi<Family>
      : UnwrapForward<D> extends Contract<infer Api>
        ? Api
        : UnwrapForward<D> extends Input<infer T>
          ? T
          : UnwrapForward<D> extends Binding<infer C>
            ? ContractApi<C>
            : UnwrapForward<D> extends AutoImplementation<infer C>
              ? ContractApi<C>
              : UnwrapForward<D> extends ImplementationSelectorDependency<infer C>
                ? ImplementationSelector<C>
                : UnwrapForward<D> extends AllImplementations<infer C>
                  ? ImplementationSet<C>
                  : UnwrapForward<D> extends EntryDescriptor<any, any>
                    ? BoundEntry<UnwrapForward<D>>
                    : never

export interface LoadOptions {
  /** Ends only this caller's wait. The shared setup attempt keeps running. */
  readonly signal?: AbortSignal
}

/**
 * Lazy access to one already-planned canonical slot. `load()` returns a plain
 * Promise; the Runtime attaches no hidden barrier or completion tracking to it.
 * The ref itself is never thenable.
 */
export interface DependencyRef<T> {
  load(options?: LoadOptions): Promise<T>
  /**
   * Start materialization of the real slot without waiting. Failures follow
   * the slot's normal failure policy and are visible to later `load()` calls.
   */
  preload(): void
}

/** Synchronous access to an Input payload. The payload is returned exactly as provided. */
export interface InputRef<T> {
  read(): T
  /** @deprecated Use `read()`. Thenable payloads are awaited by this form. */
  load(): Promise<Awaited<T>>
}

export type DependencyRefFor<D> =
  UnwrapForward<D> extends Input<infer T>
    ? InputRef<T>
    : DependencyRef<DependencyOutput<D>>

export type DependencyRefs<Requires extends DependencyMap> = {
  readonly [Key in keyof Requires]: DependencyRefFor<Requires[Key]>
}

export interface ServiceLifecycle {
  /** Aborted when the owner Env starts closing. It never force-kills JavaScript. */
  readonly signal: AbortSignal
  /** Register cleanup for resources this setup attempt created. Never close shared dependencies. */
  onDispose(cleanup: () => Awaitable<void>): void
}

export type SetupResult<Instance> = Awaitable<Instance | OpaqueInstance<Instance>>

export interface ServiceDefinition<
  Requires extends DependencyMap,
  Provides extends readonly Contract[],
  Instance,
> {
  readonly requires?: Requires
  readonly provides?: Provides
  readonly eager?: boolean
  /** `lineage` prevents a descendant from selecting or owning a divergent node. */
  readonly uniqueWithin?: 'lineage'
  readonly failure?: ServiceFailurePolicy
  /** Per-attempt initialization deadline; overrides the Runtime default. `Infinity` disables it. */
  readonly setupDeadlineMs?: number
  readonly metadata?: DescriptorMetadata
  readonly revisionMetadata?: DescriptorMetadata
  readonly setup: (
    dependencies: DependencyRefs<Requires>,
    lifecycle: ServiceLifecycle,
  ) => SetupResult<Instance>
}

/** Exact Service revision exported by one installed package instance. */
export interface ServiceRevision<Instance = unknown> {
  readonly kind: 'service-revision'
  readonly package: PackageDescriptor
  readonly family: ServiceFamily<Instance>
  readonly version: string
  readonly key: string
  readonly requires: DependencyMap
  readonly provides: readonly Contract[]
  readonly eager: boolean
  readonly failure: NormalizedServiceFailurePolicy
  readonly setupDeadlineMs: number | undefined
  readonly metadata: Readonly<DescriptorMetadata>
  setup(
    dependencies: DependencyRefs<DependencyMap>,
    lifecycle: ServiceLifecycle,
  ): SetupResult<Instance>
  range(version?: string): ServiceRange<ServiceFamily<Instance>>
}

export type ServiceInstance<S> =
  S extends ServiceRevision<infer Instance> ? Instance : never

/** Exact collection-local candidate identity. It is intentionally not durable. */
export interface CandidateRef<C extends Contract<any> = Contract<any>> {
  readonly kind: 'candidate-ref'
  readonly contract: C
  readonly familyId: string
  readonly version: string
  readonly __contract?: C
}

export interface ImplementationDescriptor<C extends Contract<any> = Contract<any>> {
  readonly contractId: string
  readonly familyId: string
  readonly version: string
  readonly eager: boolean
  readonly familyMetadata: Readonly<DescriptorMetadata>
  readonly revisionMetadata: Readonly<DescriptorMetadata>
  readonly persistentRef: PersistentImplementationRef<C>
}

export type CandidateAvailability =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable'
      readonly code: DiagnosticCode
      readonly message: string
      readonly details: Readonly<Record<string, unknown>>
    }

export interface ImplementationCandidate<C extends Contract<any> = Contract<any>>
  extends ImplementationDescriptor<C> {
  readonly ref: CandidateRef<C>
  readonly availability: CandidateAvailability
}

export type AvailableImplementationCandidate<C extends Contract<any> = Contract<any>> =
  ImplementationCandidate<C> & {
    readonly availability: { readonly status: 'available' }
  }

export interface ImplementationLease<C extends Contract<any> = Contract<any>> {
  readonly env: EnvHandle
  readonly implementation: DependencyRef<ContractApi<C>>
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Candidate list whose members are materialized in isolated child Envs.
 * @deprecated Compatibility only; `open()`/`run()` require a Ready anchor Env.
 */
export interface ImplementationSelector<C extends Contract<any> = Contract<any>>
  extends Iterable<ImplementationCandidate<C>> {
  readonly contract: C
  readonly candidates: readonly ImplementationCandidate<C>[]
  resolve(ref: PersistentImplementationRef<C>): ImplementationCandidate<C>
  open(
    candidate: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>,
  ): Promise<ImplementationLease<C>>
  run<Result>(
    candidate: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>,
    callback: (
      implementation: DependencyRef<ContractApi<C>>,
      env: EnvHandle,
    ) => Awaitable<Result>,
  ): Promise<Result>
}

/** Same-Env collection: every candidate is a real node of the current topology. */
export interface ImplementationSet<C extends Contract<any> = Contract<any>>
  extends Iterable<ImplementationCandidate<C>> {
  readonly contract: C
  readonly candidates: readonly ImplementationCandidate<C>[]
  resolve(ref: PersistentImplementationRef<C>): ImplementationCandidate<C>
  load(
    candidate: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>,
    options?: LoadOptions,
  ): Promise<ContractApi<C>>
}

export type EntryParameter = Input<any> | Binding<any>
export type EntryParameterMap = Readonly<Record<string, EntryParameter>>

export type BindingAssignment<B extends Binding<any>> =
  | PersistentImplementationRef<B['contract']>
  | ServiceRevision<ContractApi<B['contract']>>

export type EntryParameterValue<P extends EntryParameter> =
  P extends Input<infer T>
    ? T
    : P extends Binding<any>
      ? BindingAssignment<P>
      : never

export type EntryParameterValues<Parameters extends EntryParameterMap> = {
  readonly [Key in keyof Parameters]: EntryParameterValue<Parameters[Key]>
}

export type ScopeTarget = ServiceRevision<any> | ServiceFamily<any>

export interface DeriveOptions {
  readonly fresh?: readonly ScopeTarget[]
  readonly share?: readonly ScopeTarget[]
}

export interface EntryDescriptor<
  Requires extends DependencyMap = DependencyMap,
  Parameters extends EntryParameterMap = EntryParameterMap,
> {
  readonly kind: 'entry'
  readonly package: PackageDescriptor
  readonly id: string
  readonly apiVersion: number
  readonly requires: Requires
  readonly parameters: Parameters
  readonly scope: Readonly<DeriveOptions>
  readonly metadata: Readonly<DescriptorMetadata>
}

export type EntryParameters<E extends EntryDescriptor<any, any>> =
  EntryParameterValues<E['parameters']> & { readonly scope?: DeriveOptions }

export type EntryArguments<E extends EntryDescriptor<any, any>> =
  keyof E['parameters'] extends never
    ? [parameters?: EntryParameters<E>]
    : [parameters: EntryParameters<E>]

export type EntryDependencies<E extends EntryDescriptor<any, any>> =
  DependencyRefs<E['requires']>

export type EntryCallback<E extends EntryDescriptor<any, any>, Result> = (
  dependencies: EntryDependencies<E>,
  env: EnvHandle<E['requires']>,
) => Awaitable<Result>

export type EntryRunArguments<E extends EntryDescriptor<any, any>, Result> =
  keyof E['parameters'] extends never
    ? | [callback: EntryCallback<E, Result>]
      | [parameters: EntryParameters<E>, callback: EntryCallback<E, Result>]
    : [parameters: EntryParameters<E>, callback: EntryCallback<E, Result>]

export interface RuntimePolicyContext {
  readonly site: string
  readonly parentActiveRevisionKeys: ReadonlySet<string>
}

export interface RuntimePolicy {
  orderAutoCandidates(
    contract: Contract,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ): readonly ServiceRevision[]
  orderVersionCandidates(
    family: ServiceFamily,
    candidates: readonly ServiceRevision[],
    context: RuntimePolicyContext,
  ): readonly ServiceRevision[]
}

/** Read-only definition metadata. It never creates an Env or instance. */
export interface RuntimeCatalog {
  implementations<C extends Contract<any>>(
    contract: C,
  ): readonly ImplementationDescriptor<C>[]
  resolve<C extends Contract<any>>(
    ref: PersistentImplementationRef<C>,
  ): ImplementationDescriptor<C>
  /** Publicly admitted exact revisions of one Service family, highest first. */
  revisions(familyId: string): readonly string[]
}

export interface ServiceOverride<
  From extends ServiceRevision<any> = ServiceRevision<any>,
  To extends ServiceRevision<any> = ServiceRevision<any>,
> {
  readonly kind: 'service-override'
  readonly from: From
  readonly to: To
}

export interface PlanCacheOptions {
  readonly maxEntries?: number
}

export interface InitializationOptions {
  /** Default per-attempt setup deadline. Reports INITIALIZATION_TIMEOUT; never proves a deadlock. */
  readonly deadlineMs?: number
}

export interface DisposalOptions {
  /** How long disposal waits for a timed-out setup attempt to actually settle before reporting it as abandoned. */
  readonly graceMs?: number
}

export interface PlanningOptions {
  /** Maximum candidate-choice expansions per Entry plan before PLANNING_BUDGET_EXCEEDED. */
  readonly searchBudget?: number
}

export type RuntimeEvent =
  | {
      readonly type: 'late-setup-result'
      readonly slot: string
      readonly revision: string
      readonly env: string
      readonly cleanupErrors: readonly unknown[]
    }
  | {
      readonly type: 'late-setup-failure'
      readonly slot: string
      readonly revision: string
      readonly env: string
      readonly error: unknown
      readonly cleanupErrors: readonly unknown[]
    }
  | {
      readonly type: 'attempt-abandoned'
      readonly slot: string
      readonly revision: string
      readonly env: string
      readonly elapsedMs: number
    }
  | {
      readonly type: 'foreign-thenable-setup'
      readonly slot: string
      readonly revision: string
      readonly env: string
    }

export interface DiagnosticsOptions {
  readonly onEvent?: (event: RuntimeEvent) => void
}

export interface CreateRuntimeOptions {
  readonly services: readonly ServiceRevision[]
  readonly policy?: Partial<RuntimePolicy>
  readonly overrides?: readonly ServiceOverride[]
  readonly planCache?: PlanCacheOptions
  readonly initialization?: InitializationOptions
  readonly disposal?: DisposalOptions
  readonly planning?: PlanningOptions
  readonly diagnostics?: DiagnosticsOptions
}

export interface RuntimeInspection {
  readonly admittedServices: readonly string[]
  readonly internalServices: readonly string[]
  readonly overriddenServices: readonly string[]
  readonly rootEnvCount: number
  readonly liveEnvCount: number
  readonly planCache: {
    readonly hits: number
    readonly misses: number
    readonly entries: number
    readonly evictions: number
    readonly maxEntries: number
  }
  readonly definitionWarnings: readonly string[]
}

export type InspectionNodeKind =
  | 'service'
  | 'input'
  | 'binding'
  | 'selector'
  | 'all'
  | 'entry'

export interface EnvInspectionNode {
  readonly nodeId: string
  readonly kind: InspectionNodeKind
  readonly label: string
  readonly slotId: string
  readonly ownerEnvId: string
  readonly state: string
  readonly dependencies: Readonly<Record<string, string>>
}

export interface EnvInspection {
  readonly id: string
  readonly parentId?: string
  readonly state: string
  readonly nodes: readonly EnvInspectionNode[]
}

export interface PlannedEnvInspection {
  readonly nodeCount: number
  readonly ownedSlotCount: number
  readonly reusedSlotCount: number
  readonly eagerServiceCount: number
  readonly selectedRevisions: Readonly<Record<string, string>>
}

export interface EntryDiagnostic {
  readonly code: DiagnosticCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

export type EntryCheck =
  | { readonly ok: true; readonly inspection: PlannedEnvInspection }
  | { readonly ok: false; readonly error: EntryDiagnostic }

/** Why a node could not reuse its parent's visible slot. */
export type ForkCause =
  | { readonly kind: 'root' }
  | { readonly kind: 'not-in-parent' }
  | { readonly kind: 'fresh'; readonly target: string }
  | { readonly kind: 'input-provided'; readonly input: string }
  | { readonly kind: 'binding-changed'; readonly binding: string }
  | { readonly kind: 'structure-changed' }
  | { readonly kind: 'anchor-dependency-mismatch'; readonly family: string; readonly via: string }
  | { readonly kind: 'dependency-forked'; readonly via: string; readonly dependency: string }

export type NodeDisposition = 'inherited' | 'new' | 'forked'

export interface ExplainedNode {
  readonly nodeId: string
  readonly kind: InspectionNodeKind
  readonly label: string
  readonly disposition: NodeDisposition
  readonly eager: boolean
  readonly cause?: ForkCause
  /** Node ids from this node to the terminal cause. */
  readonly path: readonly string[]
}

export interface ExplainCounts {
  readonly inherited: number
  readonly new: number
  readonly forked: number
}

export interface EntryExplanationSuccess {
  readonly ok: true
  readonly entry: string
  readonly parent?: string
  readonly parameters: {
    readonly inputsProvided: readonly string[]
    readonly inputsInherited: readonly string[]
    readonly bindingsResolved: Readonly<Record<string, string>>
    readonly bindingsInherited: Readonly<Record<string, string>>
  }
  readonly services: ExplainCounts & {
    readonly eagerToStart: number
    readonly eagerInherited: number
  }
  readonly inputs: { readonly inherited: number; readonly provided: number }
  readonly synthetic: ExplainCounts
  readonly choices: Readonly<Record<string, string>>
  readonly nodes: readonly ExplainedNode[]
  /** Every node that is not inherited, with cause and path. */
  readonly forks: readonly ExplainedNode[]
}

export interface EntryExplanationFailure {
  readonly ok: false
  readonly entry: string
  readonly parent?: string
  readonly error: EntryDiagnostic
  readonly missingInputs: readonly string[]
  readonly missingBindings: readonly string[]
}

export type EntryExplanation = EntryExplanationSuccess | EntryExplanationFailure

export type EnvState = 'activating' | 'ready' | 'disposing' | 'disposed'

export interface EnvHandle<Requires extends DependencyMap = DependencyMap> {
  readonly id: string
  readonly deps: DependencyRefs<Requires>
  readonly state: EnvState

  enter<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>>

  run<E extends EntryDescriptor<any, any>, Result>(
    entry: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result>

  check<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck>

  explain<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EntryExplanation>

  derive(options?: DeriveOptions): Promise<EnvHandle<{}>>
  bind<E extends EntryDescriptor<any, any>>(entry: E): BoundEntry<E>
  inspect(): EnvInspection
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface SynaRuntime {
  readonly catalog: RuntimeCatalog

  enter<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EnvHandle<E['requires']>>

  run<E extends EntryDescriptor<any, any>, Result>(
    entry: E,
    ...args: EntryRunArguments<E, Result>
  ): Promise<Result>

  check<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EntryCheck>

  explain<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryArguments<E>
  ): Promise<EntryExplanation>

  inspect(): RuntimeInspection
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

type ContractApiUnion<Provides extends readonly Contract[]> =
  Provides[number] extends infer C
    ? C extends Contract<infer Api> ? Api : never
    : never

type UnionToIntersection<Union> =
  (Union extends unknown ? (value: Union) => void : never) extends
    (value: infer Intersection) => void
      ? Intersection
      : never

export type ProvidedShape<Provides extends readonly Contract[]> =
  [Provides[number]] extends [never]
    ? unknown
    : UnionToIntersection<ContractApiUnion<Provides>>

export interface EntryDefinition<
  Requires extends DependencyMap,
  Parameters extends EntryParameterMap,
> extends DefinitionOptions {
  readonly requires?: Requires
  readonly parameters?: Parameters
  readonly scope?: DeriveOptions
}

export interface PackageDefinitions {
  readonly package: PackageDescriptor

  contract<Api>(): Contract<Api>
  contract<Api>(options: DefinitionOptions): Contract<Api>
  contract<Api>(name: string, options?: DefinitionOptions): Contract<Api>

  input<T>(name: string, options?: DefinitionOptions): Input<T>

  binding<C extends Contract<any>>(
    name: string,
    contract: C,
    options?: DefinitionOptions,
  ): Binding<C>

  service<
    const Requires extends DependencyMap = {},
    const Provides extends readonly Contract[] = readonly [],
    Instance extends ProvidedShape<Provides> = ProvidedShape<Provides>,
  >(
    definition: ServiceDefinition<Requires, Provides, Instance>,
  ): ServiceRevision<Instance>

  service<
    const Requires extends DependencyMap = {},
    const Provides extends readonly Contract[] = readonly [],
    Instance extends ProvidedShape<Provides> = ProvidedShape<Provides>,
  >(
    name: string,
    definition: ServiceDefinition<Requires, Provides, Instance>,
  ): ServiceRevision<Instance>

  entry<
    const Requires extends DependencyMap = {},
    const Parameters extends EntryParameterMap = {},
  >(
    definition: EntryDefinition<Requires, Parameters>,
  ): EntryDescriptor<Requires, Parameters>

  entry<
    const Requires extends DependencyMap = {},
    const Parameters extends EntryParameterMap = {},
  >(
    name: string,
    definition: EntryDefinition<Requires, Parameters>,
  ): EntryDescriptor<Requires, Parameters>
}

export type { SynaErrorCode }

import type { DiagnosticCode, SynaErrorCode } from './errors.js'

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
  readonly all: AllImplementations<Contract<Api>>
  readonly __type?: Api
}

export type ContractApi<C> = C extends Contract<infer Api> ? Api : never

/** A typed fact supplied externally when an Entry creates an Env. */
export interface Input<ValueType = unknown> {
  readonly kind: 'input'
  readonly id: string
  readonly apiVersion: number
  readonly metadata: Readonly<DescriptorMetadata>
  readonly __type?: ValueType
}

export type InputType<I> = I extends Input<infer T> ? T : never

/**
 * JSON-safe implementation preference (a Binding assignment, a catalog lookup);
 * never an Env-local slot reference. Serializes as
 * `{ kind, contractId, familyId, version }`. Persisted data compatibility:
 * `parse()` and every Runtime read path permanently accept the 0.5 key (`implementationId`)
 * the 0.5 line wrote for `familyId`, and report each such read as a
 * `legacy-implementation-ref` diagnostics event; `kind` is the stable
 * on-disk discriminator (its value dates from 0.4 and never changes).
 */
export interface ImplementationRef<
  C extends Contract<any> = Contract<any>,
> {
  readonly kind: 'persistent-implementation-ref'
  readonly contractId: string
  /** The implementation family (`ServiceFamily.id`). */
  readonly familyId: string
  readonly version: string
  readonly __type?: C
}

/** Stable identity shared by installed revisions of one implementation. */
export interface ServiceFamily<PublicApi = unknown> {
  readonly kind: 'service-family'
  readonly id: string
  readonly uniqueWithin: UniquenessPolicy
  readonly metadata: Readonly<DescriptorMetadata>
  readonly __type?: PublicApi
}

export type ServiceFamilyApi<F> =
  F extends ServiceFamily<infer Api> ? Api : never

/**
 * Choose a compatible revision of one Service Family among the revisions the
 * Runtime knows: the admitted ones, the consumer's private exact closure and
 * the `origin` the range was taken from. Every candidate must provide the
 * Contracts of the origin (`requiredContractIds`), which is why a range types
 * as the origin's Contract view and never as its private instance shape.
 */
export interface ServiceRange<F extends ServiceFamily<any> = ServiceFamily<any>> {
  readonly kind: 'service-range'
  readonly family: F
  readonly range: string
  /** The revision `range()` was called on; always a candidate the Runtime knows. */
  readonly origin: ServiceRevision<any, any>
  /** Contract ids a chosen revision must provide: the origin's `provides`. */
  readonly requiredContractIds: readonly string[]
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

  to<S extends ServiceRevision<any, any>>(
    service: ServiceInstance<S> extends ContractApi<C> ? S : never,
    version?: string,
  ): ImplementationRef<C>

  parse(input: unknown): ImplementationRef<C>
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

/**
 * An Entry anchored at one Env: invoking it creates a child of that Env. A
 * Service that requires an Entry receives one anchored at the owner Env of its
 * slot; `env.anchor(entry)` creates one anchored at `env`.
 */
export interface AnchoredEntry<E extends EntryDescriptor<any, any>> {
  enter(...args: EntryCallArguments<E>): Promise<EnvHandle<E['requires']>>
  run<Result>(...args: EntryRunCallArguments<E, Result>): Promise<Result>
  check(...args: EntryCallArguments<E>): Promise<EntryCheck>
  explain(...args: EntryCallArguments<E>): Promise<EntryExplanation>
}

/** Every descriptor accepted in a Service or Entry `requires` map. */
export type Dependency =
  | ServiceRevision<any, any>
  | ServiceRange<any>
  | Contract<any>
  | Input<any>
  | Binding<any>
  | AutoImplementation<any>
  | AllImplementations<any>
  | EntryDescriptor<any, any>
  | ForwardDependency<any>

export type DependencyMap = Readonly<Record<string, Dependency>>

export type UnwrapForward<D> =
  D extends ForwardDependency<infer Inner> ? UnwrapForward<Inner> : D

export type DependencyOutput<D> =
  UnwrapForward<D> extends ServiceRevision<infer Instance, any>
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
              : UnwrapForward<D> extends AllImplementations<infer C>
                ? ImplementationSet<C>
                : UnwrapForward<D> extends EntryDescriptor<any, any>
                  ? AnchoredEntry<UnwrapForward<D>>
                  : never

export interface LoadOptions {
  /** Ends only this caller's wait. The shared setup attempt keeps running. */
  readonly signal?: AbortSignal
}

/**
 * Lazy access to one already-planned Service-like slot (a Service, a range, a
 * Contract, a Binding, a collection or an anchored Entry). `load()` returns a
 * plain Promise; the Runtime attaches no hidden barrier or completion tracking
 * to it. The ref itself is never thenable.
 */
export interface ServiceRef<T> {
  load(options?: LoadOptions): Promise<T>
}

/** Synchronous access to an Input payload. The payload is returned exactly as provided. */
export interface InputRef<T> {
  read(): T
}

export type DependencyRefFor<D> =
  UnwrapForward<D> extends Input<infer T>
    ? InputRef<T>
    : ServiceRef<DependencyOutput<D>>

export type DependencyRefs<Requires extends DependencyMap> = {
  readonly [Key in keyof Requires]: DependencyRefFor<Requires[Key]>
}

export interface ServiceLifecycle {
  /** Aborted when the owner Env starts closing. It never force-kills JavaScript. */
  readonly signal: AbortSignal
  /** Register cleanup for resources this setup attempt created. Never close shared dependencies. */
  onDispose(cleanup: () => Awaitable<void>): void
}

/**
 * A setup result is awaited like any Promise-returning function. Consequently a
 * Service instance can never itself be thenable: JavaScript would assimilate
 * it on every `await`. Wrap such objects in a plain holder (`{ client }`).
 */
export type SetupResult<Instance> = Awaitable<Instance>

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

/**
 * Exact Service revision exported by one installed package instance. `Instance`
 * is what an exact reference loads; `PublicApi` (the intersection of the
 * provided Contract APIs, `unknown` without `provides`) is what a range taken
 * from this revision loads, because the Runtime may satisfy the range with
 * another revision of the Family.
 */
export interface ServiceRevision<Instance = unknown, PublicApi = unknown> {
  readonly kind: 'service-revision'
  readonly package: PackageDescriptor
  readonly family: ServiceFamily<PublicApi>
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
  /** A compatible-revision reference; it loads the Contract view of this revision, see `ServiceRange`. */
  range(version?: string): ServiceRange<ServiceFamily<PublicApi>>
}

export type ServiceInstance<S> =
  S extends ServiceRevision<infer Instance, any> ? Instance : never

/** Exact collection-local candidate identity. It is intentionally not durable. */
export interface CandidateRef<C extends Contract<any> = Contract<any>> {
  readonly kind: 'candidate-ref'
  readonly contract: C
  readonly familyId: string
  readonly version: string
  readonly __type?: C
}

export interface ImplementationDescriptor<C extends Contract<any> = Contract<any>> {
  readonly contractId: string
  readonly familyId: string
  readonly version: string
  readonly eager: boolean
  readonly familyMetadata: Readonly<DescriptorMetadata>
  readonly revisionMetadata: Readonly<DescriptorMetadata>
  readonly persistentRef: ImplementationRef<C>
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

/** Same-Env collection: every candidate is a real node of the current topology. */
export interface ImplementationSet<C extends Contract<any> = Contract<any>>
  extends Iterable<ImplementationCandidate<C>> {
  readonly contract: C
  readonly candidates: readonly ImplementationCandidate<C>[]
  resolve(ref: ImplementationRef<C>): ImplementationCandidate<C>
  load(
    candidate: ImplementationCandidate<C> | CandidateRef<C> | ImplementationRef<C>,
    options?: LoadOptions,
  ): Promise<ContractApi<C>>
}

export type EntryParameter = Input<any> | Binding<any>
export type EntryParameterMap = Readonly<Record<string, EntryParameter>>

export type BindingAssignment<B extends Binding<any>> =
  | ImplementationRef<B['contract']>
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

/** A Service revision or family named by a reuse constraint. */
export type ReuseTarget = ServiceRevision<any> | ServiceFamily<any>

/**
 * Reuse constraints of an Entry or of one call. `fresh` targets never reuse the
 * parent's slot (their reverse dependency closure is forked); `share` targets
 * must reuse it (`SHARE_CONSTRAINT_FAILED` otherwise). Targets that are not
 * active in the parent world fail with `FRESH_CONSTRAINT_FAILED`.
 */
export interface ReuseConstraints {
  readonly fresh?: readonly ReuseTarget[]
  readonly share?: readonly ReuseTarget[]
}

/** Call-time options of `enter`, `run`, `check` and `explain`. */
export interface EntryOptions {
  /** Per-call reuse constraints, merged with the Entry's own `reuse`. */
  readonly reuse?: ReuseConstraints
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
  readonly reuse: Readonly<ReuseConstraints>
  readonly metadata: Readonly<DescriptorMetadata>
}

/** The declared parameter map of an Entry: the type of its `parameters` record. */
export type EntryParameters<E extends EntryDescriptor<any, any>> = E['parameters']

/** The call-time values record of an Entry: one value per declared parameter (Input payload or Binding assignment). */
export type EntryArguments<E extends EntryDescriptor<any, any>> =
  EntryParameterValues<E['parameters']>

/** The argument tuple of `enter`/`check`/`explain` (module-internal; not part of the package surface). */
export type EntryCallArguments<E extends EntryDescriptor<any, any>> =
  keyof E['parameters'] extends never
    ? [parameters?: EntryArguments<E> | undefined, options?: EntryOptions | undefined]
    : [parameters: EntryArguments<E>, options?: EntryOptions | undefined]

export type EntryDependencies<E extends EntryDescriptor<any, any>> =
  DependencyRefs<E['requires']>

export type EntryCallback<E extends EntryDescriptor<any, any>, Result> = (
  dependencies: EntryDependencies<E>,
  env: EnvHandle<E['requires']>,
) => Awaitable<Result>

/** The argument tuple of `run` (module-internal; not part of the package surface). */
export type EntryRunCallArguments<E extends EntryDescriptor<any, any>, Result> =
  keyof E['parameters'] extends never
    ? | [callback: EntryCallback<E, Result>]
      | [parameters: EntryArguments<E> | undefined, callback: EntryCallback<E, Result>]
      | [parameters: EntryArguments<E> | undefined, options: EntryOptions | undefined, callback: EntryCallback<E, Result>]
    : | [parameters: EntryArguments<E>, callback: EntryCallback<E, Result>]
      | [parameters: EntryArguments<E>, options: EntryOptions | undefined, callback: EntryCallback<E, Result>]

export interface RuntimePolicyContext {
  /** The dependency site being resolved. */
  readonly dependencySite: string
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
    ref: ImplementationRef<C>,
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

/**
 * Runtime limits. Defaults: `setupDeadlineMs` 30_000, `disposalGraceMs` 2_000,
 * `planningBudget` 10_000, `planCacheEntries` 512.
 */
export interface RuntimeLimits {
  /** Default per-attempt setup deadline in milliseconds (30_000). Reports INITIALIZATION_TIMEOUT; never proves a deadlock. */
  readonly setupDeadlineMs?: number
  /**
   * How long disposal waits, in milliseconds (2_000), after broadcasting the
   * stop signal, for each in-flight setup attempt of the closing Env (running
   * or already timed out) to settle before abandoning it. Bounds the close:
   * once it passes, owned Ready slots are disposed, the Env leaves the
   * Runtime's registries and `dispose()` settles. An abandoned attempt keeps
   * only itself alive (via the user's own pending Promise); it is listed in
   * `inspect().unsettledAttempts`.
   */
  readonly disposalGraceMs?: number
  /** Maximum candidate-choice expansions per Entry plan before PLANNING_BUDGET_EXCEEDED (10_000). */
  readonly planningBudget?: number
  /** Plan template cache capacity (512). */
  readonly planCacheEntries?: number
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
      /** `setup`: the raw Promise is still pending. `rollback`: the setup settled but its cleanups outlived the grace. */
      readonly phase: 'setup' | 'rollback'
      readonly slot: string
      readonly revision: string
      readonly env: string
      readonly elapsedMs: number
    }
  | {
      /**
       * The raw setup Promise of a timed-out or abandoned attempt was garbage-
       * collected before settling: nothing can resolve it any more. Cleanups the
       * attempt registered were run and the attempt is settled as failed.
       */
      readonly type: 'attempt-unreachable'
      readonly slot: string
      readonly revision: string
      readonly env: string
      readonly elapsedMs: number
      readonly cleanupErrors: readonly unknown[]
    }
  | {
      readonly type: 'foreign-thenable-setup'
      readonly slot: string
      readonly revision: string
      readonly env: string
    }
  | {
      /**
       * The Runtime read an implementation reference whose family was given
       * under the 0.5 serialized key `implementationId` (a raw object carrying
       * only that key, or a ref `parse()` produced from one). The reference is
       * accepted permanently; the event is reported once per read so stored
       * documents can be rewritten to the `familyId` form at leisure.
       */
      readonly type: 'legacy-implementation-ref'
      readonly contractId: string
      readonly familyId: string
      readonly version: string
      /** Where the reference was read: a Binding site, `catalog.resolve()` or an `ImplementationSet` site. */
      readonly site: string
    }

export interface DiagnosticsOptions {
  readonly onEvent?: (event: RuntimeEvent) => void
}

export interface CreateRuntimeOptions {
  readonly services: readonly ServiceRevision[]
  readonly policy?: Partial<RuntimePolicy>
  readonly overrides?: readonly ServiceOverride[]
  readonly limits?: RuntimeLimits
  readonly diagnostics?: DiagnosticsOptions
}

/** A setup attempt whose raw Promise is still pending after its deadline passed or its owner Env closed. */
export interface UnsettledAttemptInspection {
  readonly attempt: number
  readonly slot: string
  readonly revision: string
  readonly env: string
  /**
   * `timed-out`: the deadline passed, the raw Promise is pending. `abandoned`:
   * the owner's close stopped waiting for the pending Promise. `rolling-back`:
   * the setup settled (failed, or its result was discarded) but its cleanups
   * outlived the close. `settling`: the Promise settled late or was found
   * unreachable and the late cleanups are running.
   */
  readonly state: 'timed-out' | 'abandoned' | 'rolling-back' | 'settling'
  readonly runningForMs: number
}

/**
 * Distinct descriptors the Runtime has registered so far. Planning
 * (`check`/`explain` included) registers every descriptor it meets, so these
 * counts can grow after construction, but only up to the static definition
 * set reachable from the admitted Services and the Entries ever planned (K01).
 */
export interface DefinitionCounts {
  readonly entries: number
  readonly inputs: number
  readonly bindings: number
  readonly contracts: number
  readonly families: number
}

export interface RuntimeInspection {
  readonly admittedServices: readonly string[]
  readonly internalServices: readonly string[]
  readonly overriddenServices: readonly string[]
  readonly definitions: DefinitionCounts
  /** Root Envs that have not completed their bounded close. */
  readonly rootEnvCount: number
  /** Envs (any depth) that have not completed their bounded close. */
  readonly liveEnvCount: number
  /**
   * Attempts the Runtime is still waiting on: timed out while their owner is
   * alive, or abandoned by a closed owner. Their Envs are no longer counted
   * above; the Runtime retains no Env graph for them, only this ledger.
   */
  readonly unsettledAttempts: readonly UnsettledAttemptInspection[]
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
    ...args: EntryCallArguments<E>
  ): Promise<EnvHandle<E['requires']>>

  run<E extends EntryDescriptor<any, any>, Result>(
    entry: E,
    ...args: EntryRunCallArguments<E, Result>
  ): Promise<Result>

  check<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryCheck>

  explain<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryExplanation>

  derive(reuse?: ReuseConstraints): Promise<EnvHandle<{}>>
  /** An `AnchoredEntry` anchored at this Env (public authority). */
  anchor<E extends EntryDescriptor>(entry: E): AnchoredEntry<E>
  inspect(): EnvInspection
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface Runtime {
  readonly catalog: RuntimeCatalog

  enter<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryCallArguments<E>
  ): Promise<EnvHandle<E['requires']>>

  run<E extends EntryDescriptor<any, any>, Result>(
    entry: E,
    ...args: EntryRunCallArguments<E, Result>
  ): Promise<Result>

  check<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryCallArguments<E>
  ): Promise<EntryCheck>

  explain<E extends EntryDescriptor<any, any>>(
    entry: E,
    ...args: EntryCallArguments<E>
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
  readonly reuse?: ReuseConstraints
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
  ): ServiceRevision<Instance, ProvidedShape<Provides>>

  service<
    const Requires extends DependencyMap = {},
    const Provides extends readonly Contract[] = readonly [],
    Instance extends ProvidedShape<Provides> = ProvidedShape<Provides>,
  >(
    name: string,
    definition: ServiceDefinition<Requires, Provides, Instance>,
  ): ServiceRevision<Instance, ProvidedShape<Provides>>

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

// syna-v05-compat: this file spells the expired 0.5/0.6 forms on purpose — each one must fail to compile (@ts-expect-error) next to its replacement.
import {
  createRuntime,
  definePackage,
  isSynaError,
  loadAll,
  SynaError,
  type AnchoredEntry,
  type DiagnosticCode,
  type EnvState,
  type SynaErrorCode,
  type SynaErrorDetails,
  type DependencyRefFor,
  type EntryExplanation,
  type EntryOptions,
  type Contract,
  type ContractApi,
  type Input,
  type EntryArguments,
  type EntryParameters,
  type RuntimePolicy,
  type RuntimePolicyContext,
  type EnvHandle,
  type ImplementationRef,
  type InputRef,
  type ReuseConstraints,
  type ReuseTarget,
  type Runtime,
  type ServiceRef,
  type ServiceFamily,
  type ServiceInstance,
  type ServiceRange,
} from '../src/index.js'

const define = definePackage({
  name: '@type-test/package',
  version: '2.4.1',
  syna: { id: 'type-test.package' },
})

interface Capability {
  run(input: string): Promise<number>
}

const Capability = define.contract<Capability>()
const Context = define.input<{ readonly tenant: string }>('context')
const Selected = define.binding('selected', Capability)

interface Implementation extends Capability {
  privateMethod(): string
}

const Implementation = define.service({
  provides: [Capability],
  requires: { context: Context },
  async setup({ context }): Promise<Implementation> {
    // Input refs are synchronous and keep the payload type.
    const current: { readonly tenant: string } = context.read()
    const inputRef: InputRef<{ readonly tenant: string }> = context
    void inputRef
    return {
      async run(input) {
        return input.length + current.tenant.length
      },
      privateMethod: () => 'private',
    }
  },
})

const Consumer = define.service('consumer', {
  requires: {
    exact: Implementation,
    automatic: Capability,
    implementations: Capability.all,
    configured: Selected,
  },
  setup({ exact, automatic, implementations, configured }) {
    const exactRef: ServiceRef<Implementation> = exact
    const automaticRef: ServiceRef<Capability> = automatic
    // R4 (v0.6, alias removed in 0.7): `DependencyRefFor<D>` is the ref type of a declared dependency; a Service dependency is a ServiceRef.
    const forExact: DependencyRefFor<typeof Implementation> = exact
    const stillService: ServiceRef<Implementation> = forExact
    void [exactRef, automaticRef, stillService]

    return {
      async test() {
        const exactResult: number = await (await exact.load()).run('a')
        const automaticResult: number = await (await automatic.load({ signal: AbortSignal.timeout(1000) })).run('b')
        const configuredResult: number = await (await configured.load()).run('c')
        const set = await implementations.load()
        const candidate = set.candidates[0]!
        const selectedResult: number = await (await set.load(candidate)).run('d')
        // @ts-expect-error D3 (v0.6): the selector family is gone; C.all is the only collection form.
        void Capability.selector
        const batch = await loadAll({ exact, automatic })
        const batchResult: number = await batch.exact.run('e')
        return exactResult + automaticResult + configuredResult + selectedResult + batchResult
      },
    }
  },
})

const Root = define.entry({
  requires: { consumer: Consumer },
  parameters: { context: Context, selected: Selected },
})

const validInput = {
  context: { tenant: 'demo' },
  selected: Selected.to(Implementation),
} satisfies EntryArguments<typeof Root>
void validInput

const exactInput = {
  context: { tenant: 'demo' },
  selected: Implementation,
} satisfies EntryArguments<typeof Root>
void exactInput

const Minimal = define.service('minimal', {
  setup() {
    return { ping: () => 'pong' }
  },
})
const minimalInstance: ServiceInstance<typeof Minimal> = { ping: () => 'pong' }
void minimalInstance

const NoParams = define.entry('no-params', { requires: { minimal: Minimal } })
const runtime = createRuntime({
  services: [Implementation, Consumer, Minimal],
  limits: { setupDeadlineMs: 5_000 },
  diagnostics: { onEvent: event => { void event.type } },
})
void runtime.run(NoParams, async ({ minimal }) => (await minimal.load()).ping())
void runtime.run(Root, validInput, async ({ consumer }) => (await consumer.load()).test())
const explanation: Promise<EntryExplanation> = runtime.explain(Root, validInput)
void explanation

const Broken = define.service('broken', {
  provides: [Capability],
  // @ts-expect-error Returned value does not implement Capability.run.
  setup() {
    return { nope: true }
  },
})
void Broken

const OtherContract = define.contract<{ other(): void }>('other')
const OtherService = define.service('other-service', {
  provides: [OtherContract],
  setup() {
    return { other() {} }
  },
})

// @ts-expect-error The service does not satisfy Selected's Contract API.
Selected.to(OtherService)

// @ts-expect-error Missing required Entry parameter "selected".
const missingBinding: EntryArguments<typeof Root> = { context: { tenant: 'x' } }
void missingBinding

const wrongInput: EntryArguments<typeof Root> = {
  // @ts-expect-error Input payload has the wrong type.
  context: { tenant: 123 },
  selected: Selected.to(Implementation),
}
void wrongInput

// R1 (v0.6, aliases removed in 0.7): reuse constraints at definition time and per call.
const Scoped = define.entry('scoped', { requires: { minimal: Minimal }, reuse: { fresh: [Minimal], share: [Minimal.family] } })
const constraints: ReuseConstraints = Scoped.reuse
const target: ReuseTarget = Minimal.family
const options: EntryOptions = { reuse: constraints }
void target
void runtime.enter(Scoped)
void runtime.enter(Scoped, {}, options)
void runtime.enter(Scoped, undefined, { reuse: { fresh: [Minimal] } })
void runtime.enter(Root, validInput, { reuse: { share: [Implementation] } })
void runtime.check(Root, validInput, options)
void runtime.explain(Root, validInput, options)
void runtime.run(Scoped, async ({ minimal }) => (await minimal.load()).ping())
void runtime.run(Scoped, {}, options, async ({ minimal }) => (await minimal.load()).ping())
void runtime.run(Root, validInput, options, async ({ consumer }) => (await consumer.load()).test())
void runtime.run(Root, validInput, undefined, async ({ consumer }) => (await consumer.load()).test())
// @ts-expect-error `scope` is not a definition option (removed in 0.7.0); the constraints are `reuse`.
const ScopedByOldName = define.entry('legacy-scoped', { requires: { minimal: Minimal }, scope: { fresh: [Minimal] } })
void ScopedByOldName
// @ts-expect-error a descriptor carries `reuse`, not `scope` (removed in 0.7.0).
const descriptorScope: ReuseConstraints = Scoped.scope
void descriptorScope
// @ts-expect-error `scope` is not a call parameter (removed in 0.7.0); pass `{ reuse }` as the options argument.
void runtime.enter(Root, { ...validInput, scope: { share: [Implementation] } })
// @ts-expect-error run() has no scoped form either; the options argument carries `reuse`.
void runtime.run(Root, { ...validInput, scope: { fresh: [Implementation] } }, async ({ consumer }) => (await consumer.load()).test())
// @ts-expect-error `reuse` is a call option, never a parameter key.
void runtime.enter(Root, { ...validInput, reuse: { fresh: [Implementation] } })
// @ts-expect-error The parameter values type no longer admits `scope`.
const scopedValues: EntryArguments<typeof Root> = { ...validInput, scope: { fresh: [Implementation] } }
void scopedValues
// @ts-expect-error Options carry only `reuse`.
void runtime.enter(Scoped, {}, { fresh: [Minimal] })

// R5 (v0.6, alias removed in 0.7): Binding.to()/parse() produce an ImplementationRef whose family is `familyId`.
const implementationRef: ImplementationRef<typeof Capability> = Selected.to(Implementation)
const familyId: string = implementationRef.familyId
// @ts-expect-error the 0.6 alias getter is gone (removed in 0.7.0); the family is `familyId`.
const familyByOldName: string = implementationRef.implementationId
void familyByOldName
const plainRef: ImplementationRef<typeof Capability> = { kind: 'persistent-implementation-ref', contractId: Capability.id, familyId, version: '^1.0.0' }
// @ts-expect-error a ref written in code carries `familyId`; the 0.5 serialized key is accepted by parse() only.
const refByOldKey: ImplementationRef<typeof Capability> = { kind: 'persistent-implementation-ref', contractId: Capability.id, implementationId: familyId, version: '^1.0.0' }
void [plainRef, refByOldKey, familyId, Selected.parse({ kind: 'persistent-implementation-ref', contractId: Capability.id, familyId, version: '^1.0.0' })]
void runtime.catalog.resolve(implementationRef)

// R3 (v0.6, alias removed in 0.7): createRuntime() returns a Runtime.
const typedRuntime: Runtime = runtime
void typedRuntime.catalog.revisions('type-test.package/minimal')

// R2 (v0.6): env.anchor(entry) creates an AnchoredEntry; a Service requiring an Entry receives one.
declare const someEnv: EnvHandle
const anchoredNoParams: AnchoredEntry<typeof NoParams> = someEnv.anchor(NoParams)
// @ts-expect-error env.bind() is gone (removed in 0.7.0); env.anchor() is the one form.
void someEnv.bind(NoParams)
void anchoredNoParams
void anchoredNoParams.run(async ({ minimal }) => (await minimal.load()).ping())
void anchoredNoParams.enter({}, { reuse: { fresh: [Minimal] } })
const UnitOfWork = define.service('unit-of-work', {
  requires: { work: NoParams },
  async setup({ work }) {
    const anchored: AnchoredEntry<typeof NoParams> = await work.load()
    return { run: () => anchored.run(async ({ minimal }) => (await minimal.load()).ping()) }
  },
})
void UnitOfWork

// Input refs have no load(); loadAll() therefore rejects them at compile time.
const InputConsumer = define.service('input-consumer', {
  requires: { context: Context, minimal: Minimal },
  async setup({ context, minimal }) {
    const inputKind: DependencyRefFor<typeof Context> = context
    const stillInput: InputRef<{ readonly tenant: string }> = inputKind
    void stillInput
    // @ts-expect-error Input refs must be read with read(), not batched with loadAll().
    await loadAll({ context })
    // @ts-expect-error Service refs have no read().
    minimal.read()
    // @ts-expect-error Input refs have no load(); read() returns the payload as provided.
    void context.load()
    return {}
  },
})
void InputConsumer

// A range loads the Contract view of its origin revision (third review round, C2):
// the Runtime may satisfy it with another revision of the Family, so revision-private
// members are not visible through it, and a revision without `provides` yields `unknown`.
const ViaRange = define.service('via-range', {
  requires: { impl: Implementation.range('^2'), bare: Minimal.range() },
  async setup({ impl, bare }) {
    const api: Capability = await impl.load()
    const rangeRef: ServiceRef<Capability> = impl
    void rangeRef
    // @ts-expect-error `privateMethod` belongs to the revision, not to the Contract view a range loads.
    void (await impl.load()).privateMethod()
    const bareValue: unknown = await bare.load()
    // @ts-expect-error Without `provides` the range yields `unknown`.
    void (await bare.load()).ping()
    return { api, bareValue }
  },
})
void ViaRange
// D4 (v0.6): `serviceRange(revision, range)` is gone; `revision.range(range)` is the one form.
const viaRange: ServiceRange<ServiceFamily<Capability>> = Implementation.range('^2')
void viaRange
const exactStillFull: ServiceRef<Implementation> = null as unknown as ServiceRef<ServiceInstance<typeof Implementation>>
void exactStillFull

// R6 (v0.6, alias removed in 0.7): the policy context names the dependency site as `dependencySite`.
const policy: RuntimePolicy = {
  orderAutoCandidates(_contract, candidates, context) {
    const site: string = context.dependencySite
    // @ts-expect-error `site` is gone (removed in 0.7.0); the name is `dependencySite`.
    void context.site
    return candidates.filter(() => site.length > 0)
  },
  orderVersionCandidates(_family, candidates, context) {
    const keys: ReadonlySet<string> = context.parentActiveRevisionKeys
    void keys
    return candidates
  },
}
void policy
const policyContext: RuntimePolicyContext = { dependencySite: 'x', parentActiveRevisionKeys: new Set() }
void policyContext
// @ts-expect-error `site` is not a member of the context.
const contextByOldName: RuntimePolicyContext = { dependencySite: 'x', site: 'x', parentActiveRevisionKeys: new Set() }
void contextByOldName
// @ts-expect-error `dependencySite` is required.
const partialContext: RuntimePolicyContext = { parentActiveRevisionKeys: new Set() }
void partialContext

// M1 (v0.6, nested records removed in 0.7): one `limits` record.
const limited: Runtime = createRuntime({ services: [Implementation], limits: { setupDeadlineMs: 5_000, disposalGraceMs: 1_000, planningBudget: 100, planCacheEntries: 8 } })
void limited
// @ts-expect-error the old key names do not exist inside `limits`.
createRuntime({ services: [Implementation], limits: { deadlineMs: 5_000 } })
// @ts-expect-error the 0.5 nested records are gone (removed in 0.7.0): the plan cache size is limits.planCacheEntries.
createRuntime({ services: [Implementation], planCache: { maxEntries: 8 } })
// @ts-expect-error the setup deadline is limits.setupDeadlineMs.
createRuntime({ services: [Implementation], initialization: { deadlineMs: 5_000 } })
// @ts-expect-error the disposal grace is limits.disposalGraceMs.
createRuntime({ services: [Implementation], disposal: { graceMs: 1_000 } })
// @ts-expect-error the planning budget is limits.planningBudget.
createRuntime({ services: [Implementation], planning: { searchBudget: 100 } })

// M2 (v0.6): `EntryParameters<E>` is the declared parameter map; `EntryArguments<E>` the call-time values record.
const declaredParameters: EntryParameters<typeof Root> = { context: Context, selected: Selected }
void declaredParameters
// @ts-expect-error a values record is not the declared parameter map.
const notTheDeclaredMap: EntryParameters<typeof Root> = { context: { tenant: 'x' }, selected: Implementation }
void notTheDeclaredMap
const callValues: EntryArguments<typeof Root> = { context: { tenant: 'x' }, selected: Implementation }
void callValues

// T2 (v0.6): every descriptor carries its phantom type as `__type`; `kind` keeps the kinds apart.
declare const phantomContract: Contract<{ ping(): void }>
declare const phantomInput: Input<{ ping(): void }>
// @ts-expect-error an Input is not a Contract, even with the same phantom type.
const contractFromInput: Contract<{ ping(): void }> = phantomInput
// @ts-expect-error a Contract is not an Input.
const inputFromContract: Input<{ ping(): void }> = phantomContract
void [contractFromInput, inputFromContract]
const inferredApi: ContractApi<typeof phantomContract> = { ping() {} }
void inferredApi
// @ts-expect-error the Api parameter is still inferred through the phantom field.
const wrongApi: ContractApi<typeof phantomContract> = { pong() {} }
void wrongApi

// T1 (v0.6): `SynaError` is a union discriminated by `code`; `isSynaError(error, code)` and `error.code === code` narrow `details`.
declare const caught: unknown
if (isSynaError(caught, 'MISSING_INPUT')) {
  const missing: readonly string[] = caught.details.missing
  void missing
  if ('input' in caught.details) {
    const input: string = caught.details.input
    void input
  }
  else {
    const entry: string = caught.details.entry
    void entry
  }
  // @ts-expect-error `budget` belongs to PLANNING_BUDGET_EXCEEDED, not MISSING_INPUT.
  void caught.details.budget
}
if (isSynaError(caught)) {
  const anyCode: SynaErrorCode = caught.code
  void anyCode
  switch (caught.code) {
    case 'PLANNING_BUDGET_EXCEEDED': {
      const budget: number = caught.details.budget
      void budget
      break
    }
    case 'OWNER_NOT_READY': {
      const state: EnvState = caught.details.state
      void state
      break
    }
    case 'INITIALIZATION_TIMEOUT': {
      const pending: readonly { readonly slot: string; readonly waitingMs: number }[] = caught.details.pendingLoads
      void pending
      break
    }
    default:
      break
  }
  if (caught.code === 'LOAD_CANCELLED') {
    const slot: string = caught.details.slot
    void slot
    // @ts-expect-error `details` of LOAD_CANCELLED has no `env`.
    void caught.details.env
  }
}
const oneMember: SynaError<'MISSING_INPUT'> = new SynaError('MISSING_INPUT', 'm', { input: 'i', site: 's', missing: ['i'] })
const widened: SynaError = oneMember
void widened
const fromWidened: SynaErrorCode = widened.code
void fromWidened
// @ts-expect-error a MISSING_SERVICE error is not a MISSING_INPUT error.
const wrongMember: SynaError<'MISSING_INPUT'> = new SynaError('MISSING_SERVICE', 'm', { revision: 'r' })
void wrongMember
// @ts-expect-error PLANNING_BUDGET_EXCEEDED details require `budget`.
new SynaError('PLANNING_BUDGET_EXCEEDED', 'm', { site: 's' })
// @ts-expect-error the details of another code are rejected.
new SynaError('LOAD_CANCELLED', 'm', { entry: 'e', env: 'x' })
// @ts-expect-error codes whose details have required fields cannot omit them.
new SynaError('LOAD_CANCELLED', 'm')
// @ts-expect-error unknown codes are rejected.
new SynaError('NOT_A_CODE', 'm', {})
const optionalDetails: SynaError<'INVALID_ENV_STATE'> = new SynaError('INVALID_ENV_STATE', 'm')
const noDetails: SynaError<'RUNTIME_MISMATCH'> = new SynaError('RUNTIME_MISMATCH', 'm')
const withCause: SynaError<'RUNTIME_MISMATCH'> = new SynaError('RUNTIME_MISMATCH', 'm', {}, { cause: new Error('inner') })
void [optionalDetails, noDetails, withCause]
const detailsShape: SynaErrorDetails['SHARE_CONSTRAINT_FAILED'] = { revision: 'r', env: 'e', cause: undefined, path: [] }
void detailsShape
const diagnosticCode: DiagnosticCode = 'UNKNOWN_ERROR'
void diagnosticCode
// @ts-expect-error UNKNOWN_ERROR is a diagnostic code, not a SynaError code.
const notAnErrorCode: SynaErrorCode = 'UNKNOWN_ERROR'
void notAnErrorCode

// The ten 0.6 alias type names are not exported any more (removed in 0.7.0).
// @ts-expect-error BoundEntry → AnchoredEntry
import type { BoundEntry } from '../src/index.js'
// @ts-expect-error DependencyRef → ServiceRef | InputRef (DependencyRefFor<D> for a declared dependency)
import type { DependencyRef } from '../src/index.js'
// @ts-expect-error DeriveOptions → ReuseConstraints
import type { DeriveOptions } from '../src/index.js'
// @ts-expect-error DisposalOptions → RuntimeLimits.disposalGraceMs
import type { DisposalOptions } from '../src/index.js'
// @ts-expect-error InitializationOptions → RuntimeLimits.setupDeadlineMs
import type { InitializationOptions } from '../src/index.js'
// @ts-expect-error PersistentImplementationRef → ImplementationRef
import type { PersistentImplementationRef } from '../src/index.js'
// @ts-expect-error PlanCacheOptions → RuntimeLimits.planCacheEntries
import type { PlanCacheOptions } from '../src/index.js'
// @ts-expect-error PlanningOptions → RuntimeLimits.planningBudget
import type { PlanningOptions } from '../src/index.js'
// @ts-expect-error ScopeTarget → ReuseTarget
import type { ScopeTarget } from '../src/index.js'
// @ts-expect-error SynaRuntime → Runtime
import type { SynaRuntime } from '../src/index.js'
declare const deletedNames: [BoundEntry, DependencyRef, DeriveOptions, DisposalOptions, InitializationOptions, PersistentImplementationRef, PlanCacheOptions, PlanningOptions, ScopeTarget, SynaRuntime]
void deletedNames

import {
  createRuntime,
  definePackage,
  loadAll,
  serviceRange,
  type AnchoredEntry,
  type BoundEntry,
  type DependencyRef,
  type DeriveOptions,
  type EntryExplanation,
  type EntryOptions,
  type EntryParameters,
  type RuntimePolicy,
  type RuntimePolicyContext,
  type EnvHandle,
  type ImplementationRef,
  type InputRef,
  type PersistentImplementationRef,
  type ReuseConstraints,
  type ReuseTarget,
  type Runtime,
  type ScopeTarget,
  type ServiceRef,
  type SynaRuntime,
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
    selector: Capability.all,
    configured: Selected,
  },
  setup({ exact, automatic, selector, configured }) {
    const exactRef: ServiceRef<Implementation> = exact
    const automaticRef: ServiceRef<Capability> = automatic
    // R4 (v0.6): the deprecated name is the union of both ref kinds; the loadable kind is ServiceRef.
    const legacyExact: DependencyRef<Implementation> = exact
    const narrowed: ServiceRef<Implementation> | undefined = 'load' in legacyExact ? legacyExact : undefined
    void [exactRef, automaticRef, narrowed]

    return {
      async test() {
        const exactResult: number = await (await exact.load()).run('a')
        const automaticResult: number = await (await automatic.load({ signal: AbortSignal.timeout(1000) })).run('b')
        const configuredResult: number = await (await configured.load()).run('c')
        const implementations = await selector.load()
        const candidate = implementations.candidates[0]!
        const selectedResult: number = await (await implementations.load(candidate)).run('d')
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
} satisfies EntryParameters<typeof Root>
void validInput

const exactInput = {
  context: { tenant: 'demo' },
  selected: Implementation,
} satisfies EntryParameters<typeof Root>
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
  initialization: { deadlineMs: 5_000 },
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
const missingBinding: EntryParameters<typeof Root> = { context: { tenant: 'x' } }
void missingBinding

const wrongInput: EntryParameters<typeof Root> = {
  // @ts-expect-error Input payload has the wrong type.
  context: { tenant: 123 },
  selected: Selected.to(Implementation),
}
void wrongInput

// R1 (v0.6): reuse constraints at definition time and per call; the deprecated 0.5 forms still compile.
const Scoped = define.entry('scoped', { requires: { minimal: Minimal }, reuse: { fresh: [Minimal], share: [Minimal.family] } })
const constraints: ReuseConstraints = Scoped.reuse
const legacyConstraints: DeriveOptions = constraints
const target: ReuseTarget = Minimal.family
const legacyTarget: ScopeTarget = target
const options: EntryOptions = { reuse: constraints }
void [legacyConstraints, legacyTarget]
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
const LegacyScoped = define.entry('legacy-scoped', { requires: { minimal: Minimal }, scope: { fresh: [Minimal] } })
const legacyDescriptorScope: ReuseConstraints = LegacyScoped.scope
void legacyDescriptorScope
void runtime.enter(LegacyScoped, { scope: { fresh: [Minimal] } })
void runtime.enter(Root, { ...validInput, scope: { share: [Implementation] } })
void runtime.run(Root, { ...validInput, scope: { fresh: [Implementation] } }, async ({ consumer }) => (await consumer.load()).test())
void runtime.run(LegacyScoped, { scope: { fresh: [Minimal] } }, async ({ minimal }) => (await minimal.load()).ping())
// @ts-expect-error `reuse` is a call option, never a parameter key.
void runtime.enter(Root, { ...validInput, reuse: { fresh: [Implementation] } })
// @ts-expect-error The parameter values type no longer admits `scope`.
const scopedValues: EntryParameters<typeof Root> = { ...validInput, scope: { fresh: [Implementation] } }
void scopedValues
// @ts-expect-error Options carry only `reuse`.
void runtime.enter(Scoped, {}, { fresh: [Minimal] })

// R5 (v0.6): Binding.to()/parse() produce an ImplementationRef with `familyId`; the 0.5 names still compile.
const implementationRef: ImplementationRef<typeof Capability> = Selected.to(Implementation)
const legacyRef: PersistentImplementationRef<typeof Capability> = implementationRef
const familyId: string = implementationRef.familyId
const legacyFamilyId: string | undefined = legacyRef.implementationId
const plainRef: ImplementationRef<typeof Capability> = { kind: 'persistent-implementation-ref', contractId: Capability.id, familyId, version: '^1.0.0' }
void plainRef
void [familyId, legacyFamilyId, Selected.parse({ kind: 'persistent-implementation-ref', contractId: Capability.id, familyId, version: '^1.0.0' })]
void runtime.catalog.resolve(implementationRef)

// R3 (v0.6): createRuntime() returns a Runtime; SynaRuntime is the deprecated alias of the same type.
const typedRuntime: Runtime = runtime
const legacyRuntime: SynaRuntime = typedRuntime
const backToRuntime: Runtime = legacyRuntime
void backToRuntime.catalog.revisions('type-test.package/minimal')

// R2 (v0.6): env.anchor(entry) creates an AnchoredEntry; a Service requiring an Entry receives one.
declare const someEnv: EnvHandle
const anchoredNoParams: AnchoredEntry<typeof NoParams> = someEnv.anchor(NoParams)
const legacyBound: BoundEntry<typeof NoParams> = someEnv.bind(NoParams)
const stillAnchored: AnchoredEntry<typeof NoParams> = legacyBound
void [anchoredNoParams, stillAnchored]
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
    const eitherKind: DependencyRef<{ readonly tenant: string }> = context
    void eitherKind
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
    const rangeRef: DependencyRef<Capability> = impl
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
const viaHelper: ServiceRange<ServiceFamily<Capability>> = serviceRange(Implementation, '^2')
void viaHelper
const exactStillFull: DependencyRef<Implementation> = null as unknown as DependencyRef<ServiceInstance<typeof Implementation>>
void exactStillFull

// R6 (v0.6): the policy context names the dependency site as `dependencySite`; `site` is the deprecated 0.5 name
// and reads the same string.
const policy: RuntimePolicy = {
  orderAutoCandidates(_contract, candidates, context) {
    const site: string = context.dependencySite
    const legacy: string = context.site
    void legacy
    return candidates.filter(() => site.length > 0)
  },
  orderVersionCandidates(_family, candidates, context) {
    const keys: ReadonlySet<string> = context.parentActiveRevisionKeys
    void keys
    return candidates
  },
}
void policy
const policyContext: RuntimePolicyContext = { dependencySite: 'x', site: 'x', parentActiveRevisionKeys: new Set() }
void policyContext
// @ts-expect-error `dependencySite` is required.
const partialContext: RuntimePolicyContext = { parentActiveRevisionKeys: new Set() }
void partialContext

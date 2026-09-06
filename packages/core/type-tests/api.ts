import {
  createRuntime,
  definePackage,
  loadAll,
  serviceRange,
  type DependencyRef,
  type DeriveOptions,
  type EntryExplanation,
  type EntryOptions,
  type EntryParameters,
  type InputRef,
  type ReuseConstraints,
  type ReuseTarget,
  type ScopeTarget,
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
    const exactRef: DependencyRef<Implementation> = exact
    const automaticRef: DependencyRef<Capability> = automatic
    void [exactRef, automaticRef]

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

// Input refs have no preload(); loadAll() therefore rejects them at compile time.
const InputConsumer = define.service('input-consumer', {
  requires: { context: Context, minimal: Minimal },
  async setup({ context, minimal }) {
    // @ts-expect-error Input refs must be read with read(), not batched with loadAll().
    await loadAll({ context })
    // @ts-expect-error Service refs have no read().
    minimal.read()
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

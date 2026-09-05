import {
  createRuntime,
  definePackage,
  loadAll,
  opaque,
  type DependencyRef,
  type EntryExplanation,
  type EntryParameters,
  type InputRef,
  type ServiceInstance,
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

// A setup may wrap an instance whose own API has `then` with opaque().
interface Thenish { then(): string }
const ThenishService = define.service('thenish', {
  setup: () => opaque<Thenish>({ then: () => 'not a promise' }),
})
const thenishInstance: ServiceInstance<typeof ThenishService> = { then: () => 'x' }
void thenishInstance

const NoParams = define.entry('no-params', { requires: { minimal: Minimal } })
const runtime = createRuntime({
  services: [Implementation, Consumer, Minimal, ThenishService],
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

import assert from 'node:assert/strict'
import packageJson from '#syna/package' with { type: 'json' }
import {
  createRuntime,
  definePackage,
  forward,
  type ServiceRevision,
} from '@syna/core'

const define = definePackage(packageJson)
const codeOf = (error: unknown): string | undefined =>
  (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

console.log('\n=== Core semantics demo ===')

const Epoch = define.input<symbol>('epoch')
let counterStarts = 0
const Counter = define.service('counter', {
  requires: { epoch: Epoch },
  setup({ epoch }) {
    const id = ++counterStarts
    return {
      id,
      epoch: async () => epoch.read(),
    }
  },
})

const Consumer = define.service('consumer', {
  requires: { counter: Counter },
  setup({ counter }) {
    return {
      counter: async () => counter.load(),
    }
  },
})

let eagerStarts = 0
const Eager = define.service('eager', {
  eager: true,
  setup() {
    eagerStarts += 1
    return { ready: true }
  },
})

let A!: ServiceRevision<{ name: 'a'; callB(): Promise<string> }>
let B!: ServiceRevision<{ name: 'b'; callA(): Promise<string> }>
A = define.service('cycle-a', {
  requires: { b: forward(() => B) },
  setup({ b }) {
    return { name: 'a' as const, callB: async () => (await b.load()).name }
  },
})
B = define.service('cycle-b', {
  requires: { a: forward(() => A) },
  setup({ a }) {
    return { name: 'b' as const, callA: async () => (await a.load()).name }
  },
})

const Root = define.entry('root', {
  requires: { consumer: Consumer, eager: Eager, a: A, b: B },
  parameters: { epoch: Epoch },
})
const Child = define.entry('child', {
  requires: { consumer: Consumer },
  parameters: { epoch: Epoch },
})

const runtime = createRuntime({ services: [Consumer, Counter, Eager, A, B] })
const root = await runtime.enter(Root, { epoch: Symbol('root') })
const eagerStartsAfterEnter = eagerStarts
console.log('Eager service started during Entry activation:', eagerStartsAfterEnter)

const { consumer: consumerRef } = root.deps
const counterStartsBeforeLoad = counterStarts
console.log('Destructuring a dependency ref is still lazy:', counterStartsBeforeLoad === 0)
const rootConsumer = await consumerRef.load()
const rootCounter = await rootConsumer.counter()
console.log('Counter materialized after await:', rootCounter.id)
const aSeesB = await (await root.deps.a.load()).callB()
const bSeesA = await (await root.deps.b.load()).callA()
console.log('Structural cycle works after setup:', aSeesB, bSeesA)

const child = await root.enter(Child, { epoch: Symbol('child') })
const childCounter = await (await child.deps.consumer.load()).counter()
console.log('Re-providing an Input forks its reverse closure:',
  childCounter.id !== rootCounter.id,
)
await child.dispose()
await root.dispose()
const liveEnvs = runtime.inspect().liveEnvCount
await runtime.dispose()

// A setup-time wait cycle is rejected: the setup deadline fires and the diagnosis names the
// observed load() cycle. The deadline is short here only to keep the demo quick (default 30 s).
let C!: ServiceRevision<object>
let D!: ServiceRevision<object>
C = define.service('setup-cycle-c', {
  requires: { d: forward(() => D) },
  async setup({ d }) {
    await d.load()
    return {}
  },
})
D = define.service('setup-cycle-d', {
  requires: { c: forward(() => C) },
  async setup({ c }) {
    await c.load()
    return {}
  },
})
const BadEntry = define.entry('bad-cycle', { requires: { c: C } })
const badRuntime = createRuntime({ services: [C, D], initialization: { deadlineMs: 1_000 } })
const badEnv = await badRuntime.enter(BadEntry)
let waitCycleError: unknown
try {
  await badEnv.deps.c.load()
}
catch (error) {
  waitCycleError = error
  console.log('Setup wait cycle rejected:', messageOf(error))
}
await badEnv.dispose()
await badRuntime.dispose()

// Lineage-fixed families reject descendant divergence across versions.
const fixedV1 = definePackage({
  name: '@syna-demo/fixed-v1',
  version: '1.0.0',
  syna: { id: 'demo.fixed-service' },
}).service({ uniqueWithin: 'lineage', setup: () => ({ version: 1 }) })
const fixedV2 = definePackage({
  name: '@syna-demo/fixed-v2',
  version: '2.0.0',
  syna: { id: 'demo.fixed-service' },
}).service({ uniqueWithin: 'lineage', setup: () => ({ version: 2 }) })
const fixedEntries = definePackage({
  name: '@syna-demo/fixed-entry', version: '1.0.0', syna: { id: 'demo.fixed-entry' },
})
const FixedRoot = fixedEntries.entry('root', { requires: { fixed: fixedV1 } })
const FixedChild = fixedEntries.entry('child', { requires: { fixed: fixedV2 } })
const fixedRuntime = createRuntime({ services: [fixedV1, fixedV2] })
const fixedRoot = await fixedRuntime.enter(FixedRoot)
let lineageError: unknown
try {
  await fixedRoot.enter(FixedChild)
}
catch (error) {
  lineageError = error
  console.log('Lineage-fixed conflict rejected:', messageOf(error))
}
await fixedRoot.dispose()
await fixedRuntime.dispose()

// The demo checks what it printed (I-112).
assert.equal(eagerStartsAfterEnter, 1)
assert.equal(counterStartsBeforeLoad, 0)
assert.equal(rootCounter.id, 1)
assert.deepEqual([aSeesB, bSeesA], ['b', 'a'])
assert.notEqual(childCounter.id, rootCounter.id)
assert.equal(liveEnvs, 0)
assert.equal(codeOf(waitCycleError), 'INITIALIZATION_TIMEOUT')
assert.match(messageOf(waitCycleError), /form a cycle/)
assert.equal(codeOf(lineageError), 'LINEAGE_UNIQUENESS_CONFLICT')
console.log('demo: OK')

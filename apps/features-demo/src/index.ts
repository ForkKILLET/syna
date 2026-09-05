import packageJson from '#syna/package' with { type: 'json' }
import {
  createRuntime,
  definePackage,
  forward,
  type ServiceRevision,
} from '@syna/core'

const define = definePackage(packageJson)

console.log('\n=== Core semantics demo ===')

const Epoch = define.input<symbol>('epoch')
let counterStarts = 0
const Counter = define.service('counter', {
  requires: { epoch: Epoch },
  setup({ epoch }) {
    const id = ++counterStarts
    return {
      id,
      epoch: async () => epoch.load(),
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
console.log('Eager service started during Entry activation:', eagerStarts)

const { consumer: consumerRef } = root.deps
console.log('Destructuring a dependency ref is still lazy:', counterStarts === 0)
const rootConsumer = await consumerRef.load()
const rootCounter = await rootConsumer.counter()
console.log('Counter materialized after await:', rootCounter.id)
console.log('Structural cycle works after setup:',
  await (await root.deps.a.load()).callB(),
  await (await root.deps.b.load()).callA(),
)

const child = await root.enter(Child, { epoch: Symbol('child') })
const childCounter = await (await child.deps.consumer.load()).counter()
console.log('Re-providing an Input forks its reverse closure:',
  childCounter.id !== rootCounter.id,
)
await child.dispose()
await root.dispose()

// A setup-time wait cycle is rejected.
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
const badRuntime = createRuntime({ services: [C, D] })
const badEnv = await badRuntime.enter(BadEntry)
try {
  await badEnv.deps.c.load()
}
catch (error) {
  console.log('Setup wait cycle rejected:',
    error instanceof Error ? error.message : String(error))
}
await badEnv.dispose()

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
try {
  await fixedRoot.enter(FixedChild)
}
catch (error) {
  console.log('Lineage-fixed conflict rejected:',
    error instanceof Error ? error.message : String(error))
}
await fixedRoot.dispose()

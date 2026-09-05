import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntime,
  definePackage,
  forward,
  override,
} from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@test/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const withTimeout = async (promise, milliseconds = 1000) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms.`)), milliseconds)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

test('selector candidate plan templates are reused and the cache remains bounded', async () => {
  const define = makeDefine('v04.selector-cache')
  const Capability = define.contract()
  const Request = define.input('request')
  const providers = [1, 2, 3].map(index => makeDefine(`v04.selector-provider-${index}`).service({
    provides: [Capability],
    setup: () => ({ index }),
  }))
  const Panel = define.service('panel', {
    requires: { request: Request, selector: Capability.selector },
    setup: ({ selector }) => ({ selector }),
  })
  const Base = define.entry('base', {})
  const RequestEntry = define.entry('request', {
    requires: { panel: Panel },
    parameters: { request: Request },
  })
  const runtime = createRuntime({ services: [Panel, ...providers], planCache: { maxEntries: 32 } })
  const base = await runtime.enter(Base)

  for (let index = 0; index < 200; index += 1) {
    const request = await base.enter(RequestEntry, { request: { index } })
    await request.deps.panel.load()
    await request.dispose()
  }

  const stats = runtime.inspect().planCache
  assert.ok(stats.hits >= 199, JSON.stringify(stats))
  assert.ok(stats.misses < 15, JSON.stringify(stats))
  assert.ok(stats.entries <= 32, JSON.stringify(stats))
  await runtime.dispose()
})

test('preload is explicitly non-blocking and does not create a false setup cycle', async () => {
  const define = makeDefine('v04.preload')
  let A
  let B
  let C

  A = define.service('a', {
    requires: { c: forward(() => C) },
    setup({ c }) {
      return { preloadC: () => c.preload() }
    },
  })
  B = define.service('b', {
    requires: { a: forward(() => A) },
    async setup({ a }) {
      const readyA = await a.load()
      readyA.preloadC()
      return { name: 'b' }
    },
  })
  C = define.service('c', {
    requires: { b: forward(() => B) },
    async setup({ b }) {
      await b.load()
      return { name: 'c' }
    },
  })

  const Entry = define.entry({ requires: { a: A, b: B, c: C } })
  const runtime = createRuntime({ services: [A, B, C] })
  const env = await runtime.enter(Entry)
  await env.deps.a.load()
  assert.equal((await withTimeout(env.deps.b.load())).name, 'b')
  assert.equal((await withTimeout(env.deps.c.load())).name, 'c')
  await runtime.dispose()
})

test('dispose aborts the remaining retry schedule', async () => {
  const define = makeDefine('v04.retry-abort')
  const observed = []
  const Failing = define.service({
    failure: { attempts: 5, delayMs: 300 },
    async setup(_deps, { signal }) {
      observed.push(signal.aborted)
      throw new Error('transient')
    },
  })
  const Entry = define.entry({ requires: { failing: Failing } })
  const runtime = createRuntime({ services: [Failing] })
  const env = await runtime.enter(Entry)
  const loading = env.deps.failing.load().catch(error => error)
  await delay(30)
  const started = performance.now()
  await env.dispose()
  const elapsed = performance.now() - started
  await loading
  assert.ok(elapsed < 200, `dispose took ${elapsed.toFixed(1)} ms`)
  assert.deepEqual(observed, [false])
  await runtime.dispose()
})

test('definition override is coherent for exact, Contract, all and scope targeting', async () => {
  const define = makeDefine('v04.override')
  const Capability = define.contract()
  const Real = define.service('real', {
    provides: [Capability],
    setup: () => ({ source: 'real' }),
  })
  const Fake = define.service('fake', {
    provides: [Capability],
    setup: () => ({ source: 'fake' }),
  })
  const Consumer = define.service('consumer', {
    requires: { exact: Real, strict: Capability, all: Capability.all },
    setup: dependencies => ({ dependencies }),
  })
  const Root = define.entry('root', { requires: { consumer: Consumer } })
  const Fresh = define.entry('fresh', {
    requires: { consumer: Consumer },
    scope: { fresh: [Real] },
  })
  const runtime = createRuntime({ services: [Consumer, Real], overrides: [override(Real, Fake)] })
  const root = await runtime.enter(Root)
  const consumer = await root.deps.consumer.load()
  assert.equal((await consumer.dependencies.exact.load()).source, 'fake')
  assert.equal((await consumer.dependencies.strict.load()).source, 'fake')
  const all = await consumer.dependencies.all.load()
  assert.equal(all.candidates.length, 1)
  assert.equal((await all.load(all.candidates[0])).source, 'fake')
  const child = await root.enter(Fresh)
  assert.notStrictEqual(await child.deps.consumer.load(), consumer)
  await runtime.dispose()
})

test('a Service-owned Entry may resolve its declared exact private roots', async () => {
  const define = makeDefine('v04.private-entry')
  const Transaction = define.service('transaction', {
    setup: () => ({ id: Symbol('transaction') }),
  })
  const TransactionEntry = define.entry('transaction-entry', {
    requires: { transaction: Transaction },
  })
  const UnitOfWork = define.service('unit-of-work', {
    requires: { transactionEntry: TransactionEntry },
    setup({ transactionEntry }) {
      return {
        async run() {
          const entry = await transactionEntry.load()
          return entry.run(async ({ transaction }) => (await transaction.load()).id)
        },
      }
    },
  })
  const App = define.entry({ requires: { unitOfWork: UnitOfWork } })
  const runtime = createRuntime({ services: [UnitOfWork] })
  const env = await runtime.enter(App)
  const uow = await env.deps.unitOfWork.load()
  assert.equal(typeof await uow.run(), 'symbol')
  assert.ok(runtime.inspect().internalServices.includes(Transaction.key))
  assert.ok(!runtime.inspect().admittedServices.includes(Transaction.key))
  await runtime.dispose()
})

test('retry-on-next-load starts a fresh setup sequence after exhaustion', async () => {
  const define = makeDefine('v04.retry-next-load')
  let attempts = 0
  const Recovering = define.service({
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load' },
    setup() {
      attempts += 1
      if (attempts === 1) throw new Error('first sequence fails')
      return { attempts }
    },
  })
  const Entry = define.entry({ requires: { recovering: Recovering } })
  const runtime = createRuntime({ services: [Recovering] })
  const env = await runtime.enter(Entry)
  await assert.rejects(env.deps.recovering.load(), /first sequence fails/)
  assert.equal((await env.deps.recovering.load()).attempts, 2)
  assert.equal(attempts, 2)
  await runtime.dispose()
})

test('an eager Service may create a child Env inside the same activation transaction', async () => {
  const define = makeDefine('v04.activation-child')
  const Child = define.entry('child', {})
  let entered = false
  const Eager = define.service({
    eager: true,
    requires: { child: Child },
    async setup({ child }) {
      const bound = await child.load()
      const env = await bound.enter()
      entered = env.state === 'ready'
      return {}
    },
  })
  const Root = define.entry({ requires: { eager: Eager } })
  const runtime = createRuntime({ services: [Eager] })
  await runtime.enter(Root)
  assert.equal(entered, true)
  await runtime.dispose()
})

test('activation transactions detect parent-setup to child-eager to parent cycles', async () => {
  const define = makeDefine('v04.activation-cycle')
  let Parent
  const Worker = define.service('worker', {
    eager: true,
    requires: { parent: forward(() => Parent) },
    async setup({ parent }) {
      await parent.load()
      return {}
    },
  })
  const WorkerEntry = define.entry('worker-entry', { requires: { worker: Worker } })
  Parent = define.service('parent', {
    eager: true,
    requires: { workers: WorkerEntry },
    async setup({ workers }) {
      await (await workers.load()).enter()
      return {}
    },
  })
  const Root = define.entry({ requires: { parent: Parent } })
  const runtime = createRuntime({ services: [Parent] })
  await assert.rejects(
    withTimeout(runtime.enter(Root)),
    error => error.code === 'CIRCULAR_MATERIALIZATION',
  )
  await runtime.dispose().catch(() => undefined)
})

test('loadAll materializes named dependency refs concurrently and preserves keys', async () => {
  const { loadAll } = await import('../dist/index.js')
  const define = makeDefine('v04.load-all')
  const events = []
  const A = define.service('a', {
    async setup() {
      events.push('a-start')
      await delay(5)
      events.push('a-ready')
      return { id: 'a' }
    },
  })
  const B = define.service('b', {
    async setup() {
      events.push('b-start')
      await delay(5)
      events.push('b-ready')
      return { id: 'b' }
    },
  })
  const Entry = define.entry({ requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const env = await runtime.enter(Entry)
  const loaded = await loadAll(env.deps)
  assert.deepEqual(loaded, { a: { id: 'a' }, b: { id: 'b' } })
  assert.deepEqual(new Set(events.slice(0, 2)), new Set(['a-start', 'b-start']))
  await runtime.dispose()
})

test('Runtime, Env and implementation leases expose explicit async disposal', async () => {
  const define = makeDefine('v04.async-dispose')
  const Capability = define.contract()
  const Provider = define.service('provider', {
    provides: [Capability],
    setup: () => ({ id: 'provider' }),
  })
  const Consumer = define.service('consumer', {
    requires: { selector: Capability.selector },
    setup: dependencies => dependencies,
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer, Provider] })
  const env = await runtime.enter(Entry)
  const selector = await (await env.deps.consumer.load()).selector.load()
  const lease = await selector.open(selector.candidates[0])
  assert.equal(typeof lease[Symbol.asyncDispose], 'function')
  assert.equal(typeof env[Symbol.asyncDispose], 'function')
  assert.equal(typeof runtime[Symbol.asyncDispose], 'function')
  await lease[Symbol.asyncDispose]()
  assert.equal(lease.env.state, 'disposed')
  await env[Symbol.asyncDispose]()
  assert.equal(env.state, 'disposed')
  await runtime[Symbol.asyncDispose]()
})

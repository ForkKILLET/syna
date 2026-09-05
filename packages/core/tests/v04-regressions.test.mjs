import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auto,
  createRuntime,
  definePackage,
  override,
} from '../dist/index.js'

const defineFor = (id, version = '1.0.0') => definePackage({
  name: `@test/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

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

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition.')
    await sleep(1)
  }
}

test('selector candidate planning is reusable and bounded across short-lived request Envs', async () => {
  const define = defineFor('v04.selector-cache')
  const Capability = define.contract()
  const Request = define.input('request')
  const ProviderA = defineFor('v04.selector-cache.a').service({
    provides: [Capability],
    setup: () => ({ id: 'a' }),
  })
  const ProviderB = defineFor('v04.selector-cache.b').service({
    provides: [Capability],
    setup: () => ({ id: 'b' }),
  })
  const ProviderC = defineFor('v04.selector-cache.c').service({
    provides: [Capability],
    setup: () => ({ id: 'c' }),
  })
  const Panel = define.service('panel', {
    requires: { request: Request, selector: Capability.selector },
    setup: ({ request, selector }) => ({ request, selector }),
  })
  const Root = define.entry('root', {})
  const RequestEntry = define.entry('request', {
    requires: { panel: Panel },
    parameters: { request: Request },
  })
  const runtime = createRuntime({
    services: [Panel, ProviderA, ProviderB, ProviderC],
    planCache: { maxEntries: 32 },
  })
  const root = await runtime.enter(Root)

  for (let index = 0; index < 200; index += 1) {
    const requestEnv = await root.enter(RequestEntry, { request: index })
    await requestEnv.dispose()
  }

  const cache = runtime.inspect().planCache
  assert.ok(cache.hits > 500, `expected candidate-plan cache hits, received ${JSON.stringify(cache)}`)
  assert.ok(cache.misses <= 8, `candidate plans should not miss per Env: ${JSON.stringify(cache)}`)
  assert.ok(cache.entries <= 8, `candidate plan cache should remain bounded by semantic shapes: ${JSON.stringify(cache)}`)
  await runtime.dispose()
})

test('preload is non-blocking while un-awaited load remains a strong setup dependency', async () => {
  const define = defineFor('v04.materialization-protocol')
  let A
  let B
  let C

  A = define.service('a', {
    requires: { c: defineFor('v04.materialization-protocol-placeholder').input('unused') },
    setup: () => ({}),
  })
  // Re-declare the real cycle with forward-free late variables through closures in setup APIs.
  const Access = define.input('access')
  C = define.service('c', {
    requires: { b: { kind: 'forward-dependency', get: () => B } },
    async setup({ b }) {
      await b.load()
      return { id: 'c' }
    },
  })
  A = define.service('a-real', {
    requires: { c: C },
    setup({ c }) {
      return {
        prewarm: () => c.preload(),
        strong: () => { void c.load() },
      }
    },
  })
  B = define.service('b', {
    requires: { a: A, mode: Access },
    async setup({ a, mode }) {
      const readyA = await a.load()
      if (await mode.load() === 'preload') readyA.prewarm()
      else readyA.strong()
      return { id: 'b' }
    },
  })

  const Entry = define.entry({
    requires: { a: A, b: B, c: C },
    parameters: { mode: Access },
  })

  const safeRuntime = createRuntime({ services: [A, B, C] })
  const safeEnv = await safeRuntime.enter(Entry, { mode: 'preload' })
  await safeEnv.deps.a.load()
  assert.equal((await safeEnv.deps.b.load()).id, 'b')
  assert.equal((await safeEnv.deps.c.load()).id, 'c')
  await safeRuntime.dispose()

  const strongRuntime = createRuntime({ services: [A, B, C] })
  const strongEnv = await strongRuntime.enter(Entry, { mode: 'strong' })
  await strongEnv.deps.a.load()
  await assert.rejects(
    strongEnv.deps.b.load(),
    error => error.code === 'CIRCULAR_MATERIALIZATION',
  )
  await strongRuntime.dispose()
})

test('disposing an owner aborts an in-progress retry sequence and backoff', async () => {
  const define = defineFor('v04.retry-dispose')
  let attempts = 0
  const abortedStates = []
  const Flaky = define.service({
    failure: { attempts: 5, delayMs: 250 },
    setup(_deps, { signal }) {
      attempts += 1
      abortedStates.push(signal.aborted)
      throw new Error('still unavailable')
    },
  })
  const Entry = define.entry({ requires: { flaky: Flaky } })
  const runtime = createRuntime({ services: [Flaky] })
  const env = await runtime.enter(Entry)
  const load = env.deps.flaky.load().catch(() => undefined)
  await waitFor(() => attempts >= 1)
  const started = Date.now()
  await env.dispose()
  const elapsed = Date.now() - started
  await load

  assert.ok(elapsed < 150, `dispose waited ${elapsed} ms for a cancelled retry schedule`)
  assert.deepEqual(abortedStates, [false])
  await runtime.dispose()
})

test('definition override preserves source admission identity across exact, Contract, selector, all and scope constraints', async () => {
  const define = defineFor('v04.override')
  const Db = define.contract()
  const Real = define.service('postgres', {
    provides: [Db],
    setup: () => ({ source: 'real' }),
  })
  const Fake = define.service('fake-postgres', {
    setup: () => ({ source: 'fake' }),
  })
  const ExactConsumer = define.service('exact-consumer', {
    requires: { db: Real },
    setup: ({ db }) => ({ source: async () => (await db.load()).source }),
  })
  const ContractConsumer = define.service('contract-consumer', {
    requires: { db: Db, selector: Db.selector, all: Db.all },
    setup: dependencies => dependencies,
  })
  const Root = define.entry('root', {
    requires: { exact: ExactConsumer, contract: ContractConsumer },
  })
  const Fresh = define.entry('fresh', {
    requires: { exact: ExactConsumer },
    scope: { fresh: [Real] },
  })
  const runtime = createRuntime({
    services: [ExactConsumer, ContractConsumer, Real],
    overrides: [override(Real, Fake)],
  })

  assert.deepEqual(runtime.inspect().admittedServices, [
    ExactConsumer.key,
    ContractConsumer.key,
    Real.key,
  ].sort())
  assert.equal(runtime.catalog.implementations(Db).length, 1)
  assert.equal(runtime.catalog.implementations(Db)[0].familyId, Real.family.id)

  const root = await runtime.enter(Root)
  assert.equal(await (await root.deps.exact.load()).source(), 'fake')
  const contract = await root.deps.contract.load()
  assert.equal((await contract.db.load()).source, 'fake')
  const selector = await contract.selector.load()
  assert.equal(selector.candidates.length, 1)
  assert.equal(selector.candidates[0].familyId, Real.family.id)
  await selector.run(selector.candidates[0], async implementation => {
    assert.equal((await implementation.load()).source, 'fake')
  })
  const all = await contract.all.load()
  assert.equal(all.candidates.length, 1)
  assert.equal((await all.load(all.candidates[0])).source, 'fake')

  const fresh = await root.enter(Fresh)
  assert.notEqual(
    root.inspect().nodes.find(node => node.nodeId === `service:${Real.key}`)?.slotId,
    fresh.inspect().nodes.find(node => node.nodeId === `service:${Real.key}`)?.slotId,
  )
  await runtime.dispose()
})

test('a Service-owned Entry may resolve exact private roots without exposing them publicly', async () => {
  const define = defineFor('v04.private-entry')
  const Transaction = define.service('transaction', {
    setup: () => ({ id: 'private-transaction' }),
  })
  const TransactionEntry = define.entry('transaction-entry', {
    requires: { transaction: Transaction },
  })
  const UnitOfWork = define.service('unit-of-work', {
    requires: { transactionEntry: TransactionEntry },
    setup({ transactionEntry }) {
      return {
        async run() {
          const bound = await transactionEntry.load()
          return bound.run(async ({ transaction }) => (await transaction.load()).id)
        },
      }
    },
  })
  const Root = define.entry({ requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [UnitOfWork] })

  assert.deepEqual(runtime.inspect().admittedServices, [UnitOfWork.key])
  assert.ok(runtime.inspect().internalServices.includes(Transaction.key))
  const env = await runtime.enter(Root)
  assert.equal(await (await env.deps.uow.load()).run(), 'private-transaction')
  await runtime.dispose()
})

test('retry-on-next-load starts a new exactly-once setup sequence after exhaustion', async () => {
  const define = defineFor('v04.retry-next-load')
  let attempts = 0
  const Recoverable = define.service({
    failure: {
      attempts: 1,
      afterExhaustion: 'retry-on-next-load',
    },
    setup() {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return { attempts }
    },
  })
  const Entry = define.entry({ requires: { service: Recoverable } })
  const runtime = createRuntime({ services: [Recoverable] })
  const env = await runtime.enter(Entry)

  await assert.rejects(env.deps.service.load(), /transient/)
  const [first, second] = await Promise.all([
    env.deps.service.load(),
    env.deps.service.load(),
  ])
  assert.strictEqual(first, second)
  assert.equal(first.attempts, 2)
  assert.equal(attempts, 2)
  await runtime.dispose()
})

test('an eager Service may create a structured child Entry during owner activation', async () => {
  const define = defineFor('v04.activation-entry')
  let childStarts = 0
  let childDisposes = 0
  const Worker = define.service('worker', {
    eager: true,
    setup(_deps, { onDispose }) {
      childStarts += 1
      onDispose(() => { childDisposes += 1 })
      return { id: 'worker' }
    },
  })
  const WorkerEntry = define.entry('worker-entry', { requires: { worker: Worker } })
  const Coordinator = define.service('coordinator', {
    eager: true,
    requires: { workerEntry: WorkerEntry },
    async setup({ workerEntry }, { onDispose }) {
      const bound = await workerEntry.load()
      const child = await bound.enter()
      const worker = await child.deps.worker.load()
      onDispose(() => child.dispose())
      return { worker }
    },
  })
  const Root = define.entry({ requires: { coordinator: Coordinator } })
  const runtime = createRuntime({ services: [Coordinator] })
  const env = await runtime.enter(Root)
  assert.equal((await env.deps.coordinator.load()).worker.id, 'worker')
  assert.equal(childStarts, 1)
  await runtime.dispose()
  assert.equal(childDisposes, 1)
})

test('plan cache is capped and reports eviction rather than retaining unlimited Entry shapes', async () => {
  const define = defineFor('v04.cache-bound')
  const Service = define.service({ setup: () => ({}) })
  const runtime = createRuntime({ services: [Service], planCache: { maxEntries: 4 } })
  for (let index = 0; index < 20; index += 1) {
    const Entry = define.entry(`entry-${index}`, { requires: { service: Service } })
    const env = await runtime.enter(Entry)
    await env.dispose()
  }
  const cache = runtime.inspect().planCache
  assert.equal(cache.entries, 4)
  assert.ok(cache.evictions >= 16)
  await runtime.dispose()
})

test('selector.open participates in the surrounding setup activation transaction', async () => {
  const define = defineFor('v04.selector-activation-cycle')
  const Plugin = define.contract()
  let Manager
  const Candidate = define.service('candidate', {
    eager: true,
    provides: [Plugin],
    requires: { manager: { kind: 'forward-dependency', get: () => Manager } },
    async setup({ manager }) {
      await manager.load()
      return { id: 'candidate' }
    },
  })
  Manager = define.service('manager', {
    eager: true,
    requires: { selector: Plugin.selector },
    async setup({ selector }) {
      const implementations = await selector.load()
      await implementations.open(implementations.candidates[0])
      return { id: 'manager' }
    },
  })
  const Root = define.entry({ requires: { manager: Manager } })
  const runtime = createRuntime({ services: [Manager, Candidate] })
  await assert.rejects(
    withTimeout(runtime.enter(Root)),
    error => error.code === 'CIRCULAR_MATERIALIZATION',
  )
  await runtime.dispose().catch(() => undefined)
})

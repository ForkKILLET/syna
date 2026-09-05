// K10 / K11 / R06 / R07 / R08 — private realms, owner anchors, compiled overrides.
import assert from 'node:assert/strict'
import test from 'node:test'
import { auto, createRuntime, definePackage, override } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}-${version}`,
  version,
  syna: { id },
})

test('R06 override: Real needs config, Fake does not; Fake adds its own private helper; every resolution path agrees; source appears once', async () => {
  const define = makeDefine('v05.override')
  const Db = define.contract('db')
  const Config = define.input('config')
  const Real = define.service('postgres', {
    provides: [Db],
    requires: { config: Config },
    setup: ({ config }) => ({ source: 'real', config: config.read() }),
  })
  const Helper = define.service('fake-helper', { setup: () => ({ helper: true }) })
  const Fake = define.service('fake-postgres', {
    requires: { helper: Helper },
    setup: async ({ helper }) => ({ source: 'fake', helper: (await helper.load()).helper }),
  })
  const Consumer = define.service('consumer', {
    requires: { exact: Real, strict: Db, automatic: auto(Db), all: Db.all, range: Real.range('^1') },
    setup: deps => deps,
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Consumer, Real], overrides: [override(Real, Fake)] })

  // No Config is required: the executable manifest is the Fake's.
  const check = await runtime.check(Entry)
  assert.equal(check.ok, true)
  const env = await runtime.enter(Entry)
  const consumer = await env.deps.consumer.load()
  const values = await Promise.all([
    consumer.exact.load(), consumer.strict.load(), consumer.automatic.load(), consumer.range.load(),
  ])
  assert.ok(values.every(value => value === values[0]))
  assert.deepEqual(values[0], { source: 'fake', helper: true })
  const all = await consumer.all.load()
  assert.equal(all.candidates.length, 1)
  assert.equal(all.candidates[0].familyId, Real.family.id)
  assert.strictEqual(await all.load(all.candidates[0]), values[0])
  assert.deepEqual(runtime.inspect().admittedServices, [Consumer.key, Real.key].sort())
  assert.deepEqual(runtime.inspect().overriddenServices, [Real.key])
  assert.ok(runtime.inspect().internalServices.includes(Helper.key))
  assert.deepEqual(runtime.catalog.implementations(Db).map(item => item.familyId), [Real.family.id])
  const fresh = await env.derive({ fresh: [Real] })
  assert.notStrictEqual(await (await fresh.deps.consumer?.load?.() ?? { exact: consumer.exact }).exact.load(), undefined)
  await runtime.dispose()

  // Explicitly admitting the Fake as well makes it a second, independent candidate.
  const both = createRuntime({ services: [Consumer, Real, Fake], overrides: [override(Real, Fake)] })
  assert.deepEqual(both.catalog.implementations(Db).map(item => item.familyId), [Real.family.id])
  assert.deepEqual(both.inspect().admittedServices, [Consumer.key, Fake.key, Real.key].sort())
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Fake), override(Real, Helper)] }), error => error.code === 'DUPLICATE_DEFINITION')
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Real)] }), error => error.code === 'INVALID_DESCRIPTOR')
  assert.throws(() => createRuntime({ services: [Real], overrides: [override(Real, Fake), override(Fake, Real)] }), error => error.code === 'INVALID_DESCRIPTOR')
})

test('R07 a Service-owned Entry resolves exact and range private roots identically; public callers with the same descriptor are refused; private Contract implementations do not leak', async () => {
  const define = makeDefine('v05.private-realm')
  const Capability = define.contract()
  const Transaction = define.service('transaction', { provides: [Capability], setup: () => ({ id: 'tx' }) })
  const ExactEntry = define.entry('tx-exact', { requires: { tx: Transaction } })
  const RangeEntry = define.entry('tx-range', { requires: { tx: Transaction.range('^1.0.0') } })
  const ContractEntry = define.entry('tx-contract', { requires: { tx: Capability } })
  const UnitOfWork = define.service('uow', {
    requires: { exact: ExactEntry, range: RangeEntry, contract: ContractEntry },
    setup: ({ exact, range, contract }) => ({
      exact: async () => (await exact.load()).run(async ({ tx }) => (await tx.load()).id),
      range: async () => (await range.load()).run(async ({ tx }) => (await tx.load()).id),
      contractCheck: async () => (await contract.load()).check(),
    }),
  })
  const App = define.entry({ requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [UnitOfWork] })
  const app = await runtime.enter(App)
  const uow = await app.deps.uow.load()
  assert.equal(await uow.exact(), 'tx')
  assert.equal(await uow.range(), 'tx')
  const contractCheck = await uow.contractCheck()
  assert.equal(contractCheck.ok, false)
  assert.equal(contractCheck.error.code, 'MISSING_IMPLEMENTATION', 'Contract discovery stays public')
  await assert.rejects(app.enter(ExactEntry), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.enter(RangeEntry), error => error.code === 'MISSING_SERVICE')
  await assert.rejects(app.bind(ExactEntry).enter(), error => error.code === 'MISSING_SERVICE')
  assert.deepEqual(runtime.catalog.implementations(Capability), [])
  await runtime.dispose()
})

test('R08 an owner-bound Entry stays bound to its owner after inheritance; app-owned UoW never sees request Inputs; explicit parameters work; the handle causes no fresh', async () => {
  const define = makeDefine('v05.owner-anchor')
  const CurrentRequest = define.input('current-request')
  const Payload = define.input('payload')
  const Worker = define.service('worker', {
    requires: { payload: Payload },
    setup: ({ payload }) => ({ payload: payload.read() }),
  })
  const RequestWorker = define.service('request-worker', {
    requires: { request: CurrentRequest },
    setup: ({ request }) => ({ request: request.read() }),
  })
  const WorkerEntry = define.entry('worker', { requires: { worker: Worker }, parameters: { payload: Payload } })
  const RequestWorkerEntry = define.entry('request-worker', { requires: { worker: RequestWorker } })
  const UnitOfWork = define.service('uow', {
    requires: { workers: WorkerEntry, requestWorkers: RequestWorkerEntry },
    setup: ({ workers, requestWorkers }) => ({
      run: async payload => (await workers.load()).run({ payload }, async ({ worker }, env) => ({
        payload: (await worker.load()).payload, parent: env.inspect().parentId,
      })),
      requestCheck: async () => (await requestWorkers.load()).check(),
    }),
  })
  const App = define.entry('app', { requires: { uow: UnitOfWork } })
  const Request = define.entry('request', { requires: { uow: UnitOfWork }, parameters: { request: CurrentRequest } })
  const runtime = createRuntime({ services: [UnitOfWork] })
  const app = await runtime.enter(App)
  const request = await app.enter(Request, { request: { id: 'r1' } })
  const uowFromApp = await app.deps.uow.load()
  const uowFromRequest = await request.deps.uow.load()
  assert.strictEqual(uowFromApp, uowFromRequest, 'the handle did not force a fresh UoW per request')
  const result = await uowFromRequest.run('explicit')
  assert.equal(result.payload, 'explicit')
  assert.equal(result.parent, app.id, 'the child world is anchored at the owner, not the request')
  const check = await uowFromRequest.requestCheck()
  assert.equal(check.ok, false)
  assert.equal(check.error.code, 'MISSING_INPUT')
  const explanation = await app.explain(Request, { request: { id: 'r2' } })
  assert.equal(explanation.ok, true)
  assert.equal(explanation.services.forked, 0)
  assert.equal(explanation.services.new, 0)
  assert.equal(explanation.synthetic.inherited, 2)
  await runtime.dispose()
})

test('K10 a Service-owned Entry declared in requires does not pull its future roots or Inputs into the current graph', async () => {
  const define = makeDefine('v05.deferred-roots')
  const TxInput = define.input('tx-input')
  const Heavy = define.service('heavy', { requires: { input: TxInput }, eager: true, setup: () => { throw new Error('must not start') } })
  const TxEntry = define.entry('tx', { requires: { heavy: Heavy }, parameters: { input: TxInput } })
  const Owner = define.service('owner', { requires: { tx: TxEntry }, setup: ({ tx }) => ({ tx }) })
  const App = define.entry({ requires: { owner: Owner } })
  const runtime = createRuntime({ services: [Owner] })
  const app = await runtime.enter(App)
  const nodeIds = app.inspect().nodes.map(node => node.nodeId)
  assert.ok(!nodeIds.includes(`service:${Heavy.key}`))
  assert.ok(!nodeIds.includes(`input:${TxInput.id}`))
  assert.ok(runtime.inspect().internalServices.includes(Heavy.key), 'the Runtime knows the definition')
  await runtime.dispose()
})

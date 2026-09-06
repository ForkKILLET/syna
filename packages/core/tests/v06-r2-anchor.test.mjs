// syna-v05-compat: this file exercises the deprecated 0.5 forms on purpose, next to their 0.6 replacements (aliases removed in 0.7.0).
// R2 (v0.6): `env.anchor(entry)` / `AnchoredEntry` replace `env.bind(entry)` / `BoundEntry` (reason 1: `bind` shares
// its root with `Binding`). `bind` forwards to `anchor`: same object shape, same plans, same errors. Removed in 0.7.0.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const shape = value => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'parent' ? undefined : inner)))
const topology = env => env.inspect().nodes.map(node => ({ nodeId: node.nodeId, kind: node.kind, owned: node.ownerEnvId === env.id }))

test('R2 env.anchor(entry) and the deprecated env.bind(entry) produce equivalent anchored entries', async () => {
  const define = makeDefine('r2')
  const Flag = define.input('flag')
  const Db = define.service('db', { setup: () => ({ db: true }) })
  const Reader = define.service('reader', { requires: { db: Db, flag: Flag }, setup: ({ flag }) => ({ flag: flag.read() }) })
  const Root = define.entry('root', { requires: { db: Db } })
  const Child = define.entry('child', { requires: { reader: Reader }, parameters: { flag: Flag } })
  const runtime = createRuntime({ services: [Db, Reader] })
  const root = await runtime.enter(Root)

  const anchored = root.anchor(Child)
  const bound = root.bind(Child)
  assert.deepEqual(Object.keys(anchored).sort(), ['check', 'enter', 'explain', 'run'])
  assert.deepEqual(Object.keys(bound).sort(), Object.keys(anchored).sort())
  assert.ok(Object.isFrozen(anchored) && Object.isFrozen(bound))

  assert.deepEqual(shape(await bound.explain({ flag: 1 })), shape(await anchored.explain({ flag: 1 })))
  assert.deepEqual(await bound.check({ flag: 1 }), await anchored.check({ flag: 1 }))
  assert.deepEqual(await bound.check({}), await anchored.check({}))
  assert.equal((await anchored.check({})).ok, false)

  const a = await anchored.enter({ flag: 1 })
  const b = await bound.enter({ flag: 1 })
  assert.equal(a.inspect().parentId, root.id)
  assert.equal(b.inspect().parentId, root.id)
  assert.deepEqual(topology(b), topology(a))
  assert.strictEqual(await a.deps.reader.load() === await b.deps.reader.load(), false, 'each enter creates its own world; the Db slot is inherited')
  assert.equal(a.inspect().nodes.find(node => node.nodeId === `service:${Db.key}`).ownerEnvId, root.id)

  assert.equal(await anchored.run({ flag: 2 }, async ({ reader }) => (await reader.load()).flag), 2)
  assert.equal(await bound.run({ flag: 2 }, async ({ reader }) => (await reader.load()).flag), 2)
  assert.equal(await anchored.run({ flag: 3 }, { reuse: { fresh: [Db] } }, async ({ reader }) => (await reader.load()).flag), 3)
  assert.equal(await bound.run({ flag: 3, scope: { fresh: [Db] } }, async ({ reader }) => (await reader.load()).flag), 3)
  await a.dispose()
  await b.dispose()

  await root.dispose()
  await assert.rejects(anchored.enter({ flag: 1 }), { code: 'INVALID_ENV_STATE' })
  await assert.rejects(bound.enter({ flag: 1 }), { code: 'INVALID_ENV_STATE' })
  await runtime.dispose()
})

test('R2 private-realm checks are identical on both paths (MISSING_SERVICE for an internal Service from a public anchor)', async () => {
  const define = makeDefine('r2-private')
  const Internal = define.service('internal', { setup: () => ({}) })
  const App = define.service('app', { requires: { internal: Internal }, setup: () => ({}) })
  const AppEntry = define.entry('app', { requires: { app: App } })
  const PrivateEntry = define.entry('private', { requires: { internal: Internal } })
  const runtime = createRuntime({ services: [App] })
  const app = await runtime.enter(AppEntry)
  await assert.rejects(app.anchor(PrivateEntry).enter(), { code: 'MISSING_SERVICE' })
  await assert.rejects(app.bind(PrivateEntry).enter(), { code: 'MISSING_SERVICE' })
  assert.deepEqual(await app.bind(PrivateEntry).check(), await app.anchor(PrivateEntry).check())
  await runtime.dispose()
})

test('R2 a Service that requires an Entry receives an AnchoredEntry anchored at its owner Env', async () => {
  const define = makeDefine('r2-owner')
  const Db = define.service('db', { setup: () => ({}) })
  const Tx = define.entry('tx', { requires: { db: Db } })
  const UnitOfWork = define.service('unit-of-work', {
    requires: { tx: Tx },
    setup: async ({ tx }) => {
      const entry = await tx.load()
      return { keys: Object.keys(entry).sort(), run: () => entry.run(async (deps, env) => env.inspect().parentId) }
    },
  })
  const Root = define.entry('root', { requires: { uow: UnitOfWork } })
  const runtime = createRuntime({ services: [Db, UnitOfWork] })
  const root = await runtime.enter(Root)
  const uow = await root.deps.uow.load()
  assert.deepEqual(uow.keys, ['check', 'enter', 'explain', 'run'])
  assert.equal(await uow.run(), root.id, 'the child is anchored at the owner Env of the unit-of-work slot')
  await runtime.dispose()
})

// R1 (v0.6): `reuse: { fresh, share }` replaces `scope`, and call-time constraints move to a separate options
// argument. The deprecated forms (definition `scope`, descriptor `.scope`, parameter-record `scope`) are aliases:
// same plan, same explanation, same errors, same checks. Removed in 0.7.0.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const world = () => {
  const define = makeDefine('r1')
  const Flag = define.input('flag')
  const Db = define.service('db', { setup: () => ({ db: true }) })
  const Cache = define.service('cache', { requires: { db: Db }, setup: () => ({ cache: true }) })
  const Config = define.service('config', { requires: { flag: Flag }, setup: ({ flag }) => ({ flag: flag.read() }) })
  const App = define.service('app', { requires: { db: Db, cache: Cache, config: Config }, setup: () => ({}) })
  const Other = makeDefine('r1-other').service({ setup: () => ({}) })
  const Root = define.entry('root', { requires: { app: App }, parameters: { flag: Flag } })
  return { define, Flag, Db, Cache, Config, App, Other, Root }
}

// Explanations and inspections compared without the ids that differ between two otherwise identical worlds.
const shape = explanation => JSON.parse(JSON.stringify(explanation, (key, value) => (key === 'entry' || key === 'parent') ? undefined : value))
const topology = env => env.inspect().nodes.map(node => ({ nodeId: node.nodeId, kind: node.kind, owned: node.ownerEnvId === env.id, dependencies: Object.keys(node.dependencies).sort() }))

test('R1 definition: `reuse` and the deprecated `scope` produce the same descriptor; `scope` is a non-enumerable alias of `reuse`', () => {
  const { define, App, Cache, Db } = world()
  const viaReuse = define.entry('via-reuse', { requires: { app: App }, reuse: { fresh: [Cache], share: [Db] } })
  const viaScope = define.entry('via-scope', { requires: { app: App }, scope: { fresh: [Cache], share: [Db] } })
  assert.deepEqual(viaScope.reuse, viaReuse.reuse)
  assert.strictEqual(viaReuse.scope, viaReuse.reuse, 'the alias reads the same frozen object')
  assert.strictEqual(viaScope.scope, viaScope.reuse)
  assert.ok(!Object.keys(viaReuse).includes('scope'), 'the alias is not enumerable')
  assert.ok(Object.keys(viaReuse).includes('reuse'))
  assert.ok(Object.isFrozen(viaReuse.reuse) && Object.isFrozen(viaReuse.reuse.fresh))
  const none = define.entry('none', { requires: { app: App } })
  assert.deepEqual(none.reuse, { fresh: [], share: [] })
  assert.throws(
    () => define.entry('both', { requires: { app: App }, reuse: { fresh: [Cache] }, scope: { fresh: [Cache] } }),
    { name: 'TypeError', message: /defines both reuse and its deprecated alias scope/ },
  )
})

test('R1 definition: `reuse` and `scope` are reserved parameter names', () => {
  const { define, Flag, App } = world()
  for (const key of ['reuse', 'scope']) {
    assert.throws(
      () => define.entry(`reserved-${key}`, { requires: { app: App }, parameters: { [key]: Flag } }),
      { name: 'TypeError', message: `Entry parameter name "${key}" is reserved by Syna.` },
    )
  }
})

test('R1 call: options.reuse and the deprecated parameters.scope plan, explain, check and enter identically', async () => {
  const { define, Flag, Db, Cache, Config, App, Other, Root } = world()
  const Child = define.entry('child', { requires: { app: App }, parameters: { flag: Flag } })
  const runtime = createRuntime({ services: [Db, Cache, App, Config, Other] })
  const root = await runtime.enter(Root, { flag: 1 })

  const modern = await root.explain(Child, { flag: 2 }, { reuse: { fresh: [Cache] } })
  const legacy = await root.explain(Child, { flag: 2, scope: { fresh: [Cache] } })
  assert.equal(modern.ok, true)
  assert.deepEqual(shape(legacy), shape(modern))
  assert.ok(modern.forks.some(fork => fork.cause?.kind === 'fresh'), 'the constraint was applied')

  assert.deepEqual(await root.check(Child, { flag: 2, scope: { share: [Db] } }), await root.check(Child, { flag: 2 }, { reuse: { share: [Db] } }))

  const modernEnv = await root.enter(Child, { flag: 2 }, { reuse: { fresh: [Cache] } })
  const legacyEnv = await root.enter(Child, { flag: 2, scope: { fresh: [Cache] } })
  assert.deepEqual(topology(legacyEnv), topology(modernEnv))
  assert.notStrictEqual(await modernEnv.deps.app.load(), await root.deps.app.load(), 'fresh Cache forks App in both forms')
  await legacyEnv.dispose()
  await modernEnv.dispose()

  // run(): the callback is always last; two, three and four arguments.
  const seen = []
  await root.run(Child, { flag: 3 }, { reuse: { fresh: [Cache] } }, async (deps, env) => { seen.push(['modern', env.inspect().nodes.length, typeof deps.app.load]) })
  await root.run(Child, { flag: 3, scope: { fresh: [Cache] } }, async (deps, env) => { seen.push(['legacy', env.inspect().nodes.length, typeof deps.app.load]) })
  await root.run(Child, { flag: 3 }, undefined, async (deps, env) => { seen.push(['no-options', env.inspect().nodes.length, typeof deps.app.load]) })
  assert.deepEqual(seen.map(([, count, type]) => [count, type]), [[seen[0][1], 'function'], [seen[0][1], 'function'], [seen[0][1], 'function']])

  // Errors: an inactive target is CONSTRAINT_VIOLATION whichever form names it; a bad target is INVALID_DESCRIPTOR.
  for (const call of [
    () => root.check(Child, { flag: 2 }, { reuse: { fresh: [Other] } }),
    () => root.check(Child, { flag: 2, scope: { fresh: [Other] } }),
  ]) {
    const result = await call()
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CONSTRAINT_VIOLATION')
    assert.equal(result.error.message, `fresh targets inactive Service Revision ${Other.key}.`)
  }
  await assert.rejects(root.enter(Child, { flag: 2 }, { reuse: { fresh: ['not-a-service'] } }), { code: 'INVALID_DESCRIPTOR', message: 'Reuse targets must be Service revisions or families.' })
  await assert.rejects(root.enter(Child, { flag: 2, scope: { fresh: ['not-a-service'] } }), { code: 'INVALID_DESCRIPTOR', message: 'Reuse targets must be Service revisions or families.' })

  // One source per call: both forms together, `reuse` inside the parameter record, non-object options.
  await assert.rejects(root.enter(Child, { flag: 2, scope: { fresh: [Cache] } }, { reuse: { fresh: [Cache] } }), { name: 'TypeError', message: /both as parameters\.scope \(deprecated\) and as options\.reuse/ })
  await assert.rejects(root.enter(Child, { flag: 2, scope: { fresh: [Cache] } }, {}), { name: 'TypeError', message: /both as parameters\.scope/ })
  await assert.rejects(root.enter(Child, { flag: 2, reuse: { fresh: [Cache] } }), { name: 'TypeError', message: /reuse is a call option, not a parameter/ })
  await assert.rejects(root.enter(Child, { flag: 2 }, 'fresh'), { name: 'TypeError', message: 'Entry call options must be an object.' })
  await assert.rejects(root.enter(Child, 'flag'), { code: 'INVALID_DESCRIPTOR' })

  // No constraints at all: `{}` options, `undefined` options and the 0.5 two-argument call agree.
  const plain = shape(await root.explain(Child, { flag: 2 }))
  assert.deepEqual(shape(await root.explain(Child, { flag: 2 }, {})), plain)
  assert.deepEqual(shape(await root.explain(Child, { flag: 2 }, undefined)), plain)
  assert.deepEqual(shape(await root.explain(Child, { flag: 2, scope: undefined })), plain)
  await runtime.dispose()
})

test('R1 derive(): the argument is ReuseConstraints; behaviour unchanged', async () => {
  const { Db, Cache, Config, App, Root } = world()
  const runtime = createRuntime({ services: [Db, Cache, App, Config] })
  const root = await runtime.enter(Root, { flag: 1 })
  const derived = await root.derive({ fresh: [Cache] })
  assert.equal(derived.inspect().parentId, root.id)
  const cacheNode = derived.inspect().nodes.find(node => node.nodeId === `service:${Cache.key}`)
  assert.equal(cacheNode.ownerEnvId, derived.id)
  await assert.rejects(root.derive({ fresh: [makeDefine('r1-unknown').service({ setup: () => ({}) })] }), { code: 'CONSTRAINT_VIOLATION' })
  await runtime.dispose()
})

test('R1 anchored (bound) entries accept the same call shapes', async () => {
  const { define, Flag, Db, Cache, Config, App, Root } = world()
  const Child = define.entry('child', { requires: { app: App }, parameters: { flag: Flag } })
  const runtime = createRuntime({ services: [Db, Cache, App, Config] })
  const root = await runtime.enter(Root, { flag: 1 })
  const bound = root.bind(Child)
  const modern = shape(await bound.explain({ flag: 2 }, { reuse: { fresh: [Cache] } }))
  assert.deepEqual(shape(await bound.explain({ flag: 2, scope: { fresh: [Cache] } })), modern)
  assert.deepEqual(await bound.check({ flag: 2, scope: { share: [Db] } }), await bound.check({ flag: 2 }, { reuse: { share: [Db] } }))
  const a = await bound.enter({ flag: 2 }, { reuse: { fresh: [Cache] } })
  const b = await bound.enter({ flag: 2, scope: { fresh: [Cache] } })
  assert.deepEqual(topology(b), topology(a))
  const result = await bound.run({ flag: 2 }, { reuse: { fresh: [Cache] } }, async ({ app }) => typeof (await app.load()))
  assert.equal(result, 'object')
  await a.dispose()
  await b.dispose()
  await runtime.dispose()
})

// syna-v05-compat: this file exercises the deprecated 0.5 forms on purpose, next to their 0.6 replacements (aliases removed in 0.7.0).
// R6 (v0.6): `RuntimePolicyContext.dependencySite` replaces `site` (reason 1: "site" names choice sites throughout
// Syna's explanations; the policy receives the dependency site being resolved). `site` stays readable as a
// non-enumerable alias of `dependencySite` until 0.7.0. Same value on every policy path, same plans, same errors.
import assert from 'node:assert/strict'
import test from 'node:test'
import { auto, createRuntime, definePackage, defaultRuntimePolicy } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const shape = value => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'entry' || key === 'parent' ? undefined : inner)))

const world = () => {
  const define = makeDefine('r6')
  const Capability = define.contract()
  const V1 = makeDefine('r6-impl', '1.0.0').service({ provides: [Capability], setup: () => ({ v: 1 }) })
  const V2 = makeDefine('r6-impl', '2.0.0').service({ provides: [Capability], setup: () => ({ v: 2 }) })
  const Other = makeDefine('r6-other').service({ provides: [Capability], setup: () => ({ v: 'other' }) })
  const Choice = define.binding('choice', Capability)
  const Consumer = define.service('consumer', {
    requires: { first: auto(Capability), second: auto(Capability), chosen: Choice, all: Capability.all },
    setup: ({ first, second, chosen, all }) => ({ first, second, chosen, all }),
  })
  const Root = define.entry('root', { requires: { consumer: Consumer }, parameters: { choice: Choice } })
  return { define, Capability, V1, V2, Other, Choice, Consumer, Root }
}

// A policy that orders by the site string read through `read(context)` and records every context it saw.
const recordingPolicy = (read, seen) => ({
  orderAutoCandidates(_contract, candidates, context) {
    seen.push(['auto', read(context), [...context.parentActiveRevisionKeys].sort()])
    const byKey = key => candidates.find(candidate => candidate.key === key)
    return read(context).endsWith('dependency:first')
      ? candidates.filter(Boolean).sort((a, b) => (a.family.id === b.family.id ? b.version.localeCompare(a.version) : a.family.id.localeCompare(b.family.id)))
      : [...candidates].reverse().map(candidate => byKey(candidate.key))
  },
  orderVersionCandidates(_family, candidates, context) {
    seen.push(['version', read(context), [...context.parentActiveRevisionKeys].sort()])
    return defaultRuntimePolicy.orderVersionCandidates(_family, candidates, context)
  },
})

test('R6 context.dependencySite and the deprecated context.site read the same string on every policy path', async () => {
  const { V1, V2, Other, Choice, Consumer, Root } = world()
  const runs = []
  for (const read of [context => context.dependencySite, context => context.site]) {
    const seen = []
    const runtime = createRuntime({ services: [Consumer, V1, V2, Other], policy: recordingPolicy(read, seen) })
    const explanation = await runtime.explain(Root, { choice: Choice.to(V1) })
    assert.equal(explanation.ok, true)
    const root = await runtime.enter(Root, { choice: Choice.to(V1) })
    const consumer = await root.deps.consumer.load()
    const all = await consumer.all.load()
    const resolved = await all.load(Choice.to(V2))
    runs.push({
      explanation: shape(explanation),
      values: [(await consumer.first.load()).v, (await consumer.second.load()).v, (await consumer.chosen.load()).v, resolved.v],
      seen,
    })
    assert.ok(seen.length >= 3, 'auto, Binding and set.load() paths all consulted the policy')
    assert.ok(seen.some(([kind, site]) => kind === 'auto' && site.endsWith('dependency:first')))
    assert.ok(seen.some(([kind, site]) => kind === 'version' && site.includes('/persistent:')), 'the persistent-reference path names the family in its site')
    for (const [, site] of seen) assert.equal(typeof site, 'string')
    await runtime.dispose()
  }
  assert.deepEqual(runs[1], runs[0], 'both names see identical sites, parents, plans and outcomes')
})

test('R6 the context object: dependencySite is an own enumerable key, site is a non-enumerable getter of the same value', async () => {
  const { V1, V2, Other, Consumer, Root, Choice } = world()
  const contexts = []
  const runtime = createRuntime({
    services: [Consumer, V1, V2, Other],
    policy: { orderAutoCandidates: (_contract, candidates, context) => { contexts.push(context); return [...candidates].sort((a, b) => a.key.localeCompare(b.key)) } },
  })
  const check = await runtime.check(Root, { choice: Choice.to(V1) })
  assert.equal(check.ok, true)
  assert.ok(contexts.length > 0)
  for (const context of contexts) {
    assert.deepEqual(Object.keys(context), ['dependencySite', 'parentActiveRevisionKeys'])
    assert.equal(context.site, context.dependencySite)
    assert.equal(Object.getOwnPropertyDescriptor(context, 'site'), undefined, 'site is inherited, not an own key')
    assert.ok(context.parentActiveRevisionKeys instanceof Set)
  }
  await runtime.dispose()
})

test('R6 MISSING_AUTO_POLICY details keep the `site` key (error details are not renamed)', async () => {
  const { V1, Other, Consumer, Root, Choice } = world()
  const runtime = createRuntime({ services: [Consumer, V1, Other] })
  await assert.rejects(runtime.enter(Root, { choice: Choice.to(V1) }), error => {
    assert.equal(error.code, 'MISSING_AUTO_POLICY')
    assert.deepEqual(Object.keys(error.details).sort(), ['contract', 'families', 'site'])
    assert.match(error.details.site, /dependency:(first|second)$/)
    return true
  })
  await runtime.dispose()
})

// syna-v05-compat: the 0.5 serialized key `implementationId` is the subject of this file.
// v0.7 (A11): `ImplementationRef` serializes as `{ kind, contractId, familyId, version }` and carries nothing else —
// the 0.6 runtime alias `ref.implementationId` is gone. Persisted data written by the 0.5 line named the family under
// `implementationId`; that key is accepted permanently by `parse()` / `parseImplementationRef()` and by every Runtime
// read path, and each Runtime read of such a reference is reported once as a `legacy-implementation-ref`
// diagnostics event. `kind === 'persistent-implementation-ref'` is the stable on-disk discriminator.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, parseImplementationRef } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v07/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })
const LEGACY_KEY = 'implementationId'

const world = () => {
  const define = makeDefine('legacy')
  const Capability = define.contract('capability')
  const Choice = define.binding('choice', Capability)
  const Provider = makeDefine('legacy-provider', '1.2.0').service({ provides: [Capability], setup: () => ({ id: 'provider' }) })
  const Other = makeDefine('legacy-other').service({ provides: [Capability], setup: () => ({ id: 'other' }) })
  const Consumer = define.service('consumer', { requires: { choice: Choice, all: Capability.all }, setup: ({ choice, all }) => ({ choice, all }) })
  const Entry = define.entry('entry', { requires: { consumer: Consumer }, parameters: { choice: Choice } })
  return { define, Capability, Choice, Provider, Other, Consumer, Entry }
}

const CURRENT_KEYS = ['kind', 'contractId', 'familyId', 'version']

test('to() produces a ref that carries the serialized keys only: no implementationId property, enumerable or not', () => {
  const { Capability, Choice, Provider } = world()
  const ref = Choice.to(Provider)
  assert.deepEqual(Object.keys(ref), CURRENT_KEYS)
  assert.deepEqual(Object.getOwnPropertyNames(ref), CURRENT_KEYS)
  assert.equal(LEGACY_KEY in ref, false)
  assert.deepEqual({ ...ref }, { kind: 'persistent-implementation-ref', contractId: Capability.id, familyId: Provider.family.id, version: '^1.2.0' })
  assert.ok(Object.isFrozen(ref))
  assert.equal(JSON.stringify(ref), `{"kind":"persistent-implementation-ref","contractId":"${Capability.id}","familyId":"${Provider.family.id}","version":"^1.2.0"}`)
  assert.equal(Choice.to(Provider, '>=1 <2').version, '>=1 <2')
})

test('parse() accepts the current key, the 0.5 key, or both when equal; the result has the serialized keys only; invalid input is the same TypeError', () => {
  const { Capability, Choice, Provider } = world()
  const base = { kind: 'persistent-implementation-ref', contractId: Capability.id, version: '^1.2.0' }
  const viaFamilyId = Choice.parse({ ...base, familyId: Provider.family.id })
  const viaLegacyKey = Choice.parse({ ...base, [LEGACY_KEY]: Provider.family.id })
  const viaBoth = Choice.parse({ ...base, familyId: Provider.family.id, [LEGACY_KEY]: Provider.family.id })
  for (const parsed of [viaFamilyId, viaLegacyKey, viaBoth]) {
    assert.deepEqual({ ...parsed }, { ...Choice.to(Provider) })
    assert.deepEqual(Object.getOwnPropertyNames(parsed), CURRENT_KEYS)
    assert.equal(LEGACY_KEY in parsed, false)
    assert.equal(JSON.stringify(parsed), JSON.stringify(viaFamilyId), 'JSON carries familyId only')
    assert.ok(Object.isFrozen(parsed))
  }
  assert.deepEqual({ ...parseImplementationRef(Capability, { ...base, [LEGACY_KEY]: Provider.family.id }) }, { ...viaFamilyId })
  assert.deepEqual({ ...Choice.parse(JSON.parse(JSON.stringify(viaLegacyKey))) }, { ...viaFamilyId }, 'round trip through the current JSON form')
  const message = `Invalid persistent implementation reference for Contract ${Capability.id}.`
  assert.throws(() => Choice.parse({ ...base }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: '' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, [LEGACY_KEY]: ' ' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: Provider.family.id, [LEGACY_KEY]: 'someone-else' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: Provider.family.id, contractId: 'wrong' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: 42 }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse(null), { name: 'TypeError', message: 'A persistent implementation reference must be an object.' })
})

const legacyEvents = events => events.filter(event => event.type === 'legacy-implementation-ref')

test('every Runtime read path resolves a ref, a raw current object and a raw 0.5 object identically, and reports each read of the 0.5 form once', async () => {
  const { Capability, Choice, Provider, Other, Consumer, Entry } = world()
  const events = []
  const runtime = createRuntime({ services: [Provider, Other, Consumer], diagnostics: { onEvent: event => events.push(event) } })
  const ref = Choice.to(Provider)
  const raw = JSON.parse(JSON.stringify(ref))
  const legacy = { kind: 'persistent-implementation-ref', contractId: Capability.id, [LEGACY_KEY]: Provider.family.id, version: '^1.2.0' }
  const parsedFromLegacy = Choice.parse(legacy)
  const both = { ...raw, [LEGACY_KEY]: Provider.family.id }
  const expectedEvent = site => ({ type: 'legacy-implementation-ref', contractId: Capability.id, familyId: Provider.family.id, version: '^1.2.0', site })

  // catalog.resolve(): same descriptor for every form; the reported persistentRef is always the current form.
  const described = runtime.catalog.resolve(ref)
  assert.deepEqual(Object.keys(described.persistentRef), CURRENT_KEYS)
  for (const [form, expected] of [[raw, []], [both, []], [legacy, [expectedEvent(`catalog:${Capability.id}:${Provider.family.id}`)]], [parsedFromLegacy, [expectedEvent(`catalog:${Capability.id}:${Provider.family.id}`)]]]) {
    events.length = 0
    assert.deepEqual(runtime.catalog.resolve(form), described)
    assert.deepEqual(legacyEvents(events), expected)
    assert.equal(LEGACY_KEY in runtime.catalog.resolve(form).persistentRef, false)
  }
  const reported = runtime.catalog.resolve(legacy).persistentRef
  events.length = 0
  assert.deepEqual(runtime.catalog.resolve(reported), described)
  assert.deepEqual(legacyEvents(events), [], 'the persistentRef the Runtime reports is not a legacy reference')

  // Binding assignment at planning, ImplementationSet.resolve() and load(): one event per read of a 0.5 form.
  const ids = []
  for (const [form, expectedCount] of [[ref, 0], [raw, 0], [both, 0], [legacy, 1], [parsedFromLegacy, 1]]) {
    events.length = 0
    const env = await runtime.enter(Entry, { choice: form })
    const bindingEvents = legacyEvents(events)
    assert.equal(bindingEvents.length, expectedCount, 'the Binding assignment is read once per plan')
    if (expectedCount > 0) assert.deepEqual(bindingEvents, [expectedEvent(`binding:${Choice.id}`)])
    const consumer = await env.deps.consumer.load()
    ids.push((await consumer.choice.load()).id)
    const set = await consumer.all.load()
    events.length = 0
    assert.equal(set.resolve(form).familyId, Provider.family.id)
    assert.deepEqual(legacyEvents(events), expectedCount > 0 ? [expectedEvent(`all:${Capability.id}/persistent:${Provider.family.id}`)] : [])
    events.length = 0
    assert.equal((await set.load(form)).id, 'provider')
    assert.deepEqual(legacyEvents(events), expectedCount > 0 ? [expectedEvent(`all:${Capability.id}/persistent:${Provider.family.id}`)] : [])
    await env.dispose()
  }
  assert.deepEqual(ids, ['provider', 'provider', 'provider', 'provider', 'provider'])

  // Error details read the family from either form.
  for (const missing of [Choice.to(Provider, '^9.0.0'), { ...legacy, version: '^9.0.0' }]) {
    await assert.rejects(runtime.enter(Entry, { choice: missing }), error => {
      assert.equal(error.code, 'MISSING_IMPLEMENTATION')
      assert.deepEqual(error.details, { binding: Choice.id, implementation: Provider.family.id, version: '^9.0.0', available: ['1.2.0'] })
      return true
    })
    assert.throws(() => runtime.catalog.resolve(missing), { code: 'MISSING_IMPLEMENTATION', details: { contract: Capability.id, implementation: Provider.family.id, version: '^9.0.0', available: ['1.2.0'] } })
  }
  await runtime.dispose()
})

test('the event is diagnostics only: a throwing handler changes no outcome, and no event is reported without a handler', async () => {
  const { Capability, Choice, Provider, Other, Consumer, Entry } = world()
  const legacy = { kind: 'persistent-implementation-ref', contractId: Capability.id, [LEGACY_KEY]: Provider.family.id, version: '^1.2.0' }
  const throwing = createRuntime({ services: [Provider, Other, Consumer], diagnostics: { onEvent: () => { throw new Error('handler failure') } } })
  assert.equal(throwing.catalog.resolve(legacy).familyId, Provider.family.id)
  const env = await throwing.enter(Entry, { choice: legacy })
  assert.equal((await (await env.deps.consumer.load()).choice.load()).id, 'provider')
  await env.dispose()
  await throwing.dispose()
  const silent = createRuntime({ services: [Provider, Other, Consumer] })
  assert.equal(silent.catalog.resolve(legacy).familyId, Provider.family.id)
  await silent.dispose()
})

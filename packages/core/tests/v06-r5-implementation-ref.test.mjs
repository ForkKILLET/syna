// R5 (v0.6): `ImplementationRef` replaces `PersistentImplementationRef`, and its family field is `familyId`
// (serialized key too). Reason 3: `parseImplementationRef`, `CandidateRef.familyId` and `ImplementationDescriptor.familyId`
// already used these names. `implementationId` stays readable as a non-enumerable alias and `parse()` accepts the
// 0.5 key; `ImplementationDescriptor.persistentRef` keeps its name (`ImplementationCandidate.ref` is the CandidateRef).
// Removed in 0.7.0.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, definePackage, parseImplementationRef } from '../dist/index.js'

const makeDefine = (id, version = '1.0.0') => definePackage({ name: `@v06/${id}-${version.replaceAll('.', '-')}`, version, syna: { id } })

const world = () => {
  const define = makeDefine('r5')
  const Capability = define.contract('capability')
  const Choice = define.binding('choice', Capability)
  const Provider = makeDefine('r5-provider', '1.2.0').service({ provides: [Capability], setup: () => ({ id: 'provider' }) })
  const Other = makeDefine('r5-other').service({ provides: [Capability], setup: () => ({ id: 'other' }) })
  const Consumer = define.service('consumer', { requires: { choice: Choice, all: Capability.all }, setup: ({ choice, all }) => ({ choice, all }) })
  const Entry = define.entry('entry', { requires: { consumer: Consumer }, parameters: { choice: Choice } })
  return { define, Capability, Choice, Provider, Other, Consumer, Entry }
}

test('R5 to() produces a ref with familyId; implementationId is a non-enumerable alias; JSON carries familyId only', () => {
  const { Capability, Choice, Provider } = world()
  const ref = Choice.to(Provider)
  assert.deepEqual(Object.keys(ref), ['kind', 'contractId', 'familyId', 'version'])
  assert.deepEqual({ ...ref }, { kind: 'persistent-implementation-ref', contractId: Capability.id, familyId: Provider.family.id, version: '^1.2.0' })
  assert.equal(ref.implementationId, ref.familyId)
  assert.ok(Object.isFrozen(ref))
  assert.equal(JSON.stringify(ref), `{"kind":"persistent-implementation-ref","contractId":"${Capability.id}","familyId":"${Provider.family.id}","version":"^1.2.0"}`)
  assert.equal(Choice.to(Provider, '>=1 <2').version, '>=1 <2')
})

test('R5 parse() accepts the 0.6 key, the 0.5 key, or both when equal; anything else is the same TypeError as before', () => {
  const { Capability, Choice, Provider } = world()
  const base = { kind: 'persistent-implementation-ref', contractId: Capability.id, version: '^1.2.0' }
  const viaFamilyId = Choice.parse({ ...base, familyId: Provider.family.id })
  const viaLegacyKey = Choice.parse({ ...base, implementationId: Provider.family.id })
  const viaBoth = Choice.parse({ ...base, familyId: Provider.family.id, implementationId: Provider.family.id })
  for (const parsed of [viaFamilyId, viaLegacyKey, viaBoth]) {
    assert.deepEqual({ ...parsed }, { ...Choice.to(Provider) })
    assert.equal(parsed.implementationId, Provider.family.id)
    assert.deepEqual(Object.keys(parsed), ['kind', 'contractId', 'familyId', 'version'])
  }
  assert.deepEqual({ ...parseImplementationRef(Capability, { ...base, implementationId: Provider.family.id }) }, { ...viaFamilyId })
  assert.deepEqual({ ...Choice.parse(JSON.parse(JSON.stringify(viaLegacyKey))) }, { ...viaFamilyId }, 'round trip through the 0.6 JSON form')
  const message = `Invalid persistent implementation reference for Contract ${Capability.id}.`
  assert.throws(() => Choice.parse({ ...base }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: '' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, implementationId: ' ' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: Provider.family.id, implementationId: 'someone-else' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: Provider.family.id, contractId: 'wrong' }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse({ ...base, familyId: 42 }), { name: 'TypeError', message })
  assert.throws(() => Choice.parse(null), { name: 'TypeError', message: 'A persistent implementation reference must be an object.' })
})

test('R5 the catalog, Binding assignments and ImplementationSet.resolve() resolve a ref, a raw 0.6 object and a raw 0.5 object identically', async () => {
  const { Capability, Choice, Provider, Other, Consumer, Entry } = world()
  const runtime = createRuntime({ services: [Provider, Other, Consumer] })
  const ref = Choice.to(Provider)
  const raw = JSON.parse(JSON.stringify(ref))
  const legacy = { kind: 'persistent-implementation-ref', contractId: Capability.id, implementationId: Provider.family.id, version: '^1.2.0' }

  const described = runtime.catalog.resolve(ref)
  assert.deepEqual(runtime.catalog.resolve(raw), described)
  assert.deepEqual(runtime.catalog.resolve(legacy), described)
  assert.equal(described.familyId, Provider.family.id)
  assert.deepEqual(Object.keys(described.persistentRef), ['kind', 'contractId', 'familyId', 'version'])
  assert.equal(runtime.catalog.implementations(Capability).find(item => item.familyId === Other.family.id).persistentRef.familyId, Other.family.id)

  const ids = []
  for (const assignment of [ref, raw, legacy]) {
    const env = await runtime.enter(Entry, { choice: assignment })
    const consumer = await env.deps.consumer.load()
    ids.push((await consumer.choice.load()).id)
    const set = await consumer.all.load()
    assert.equal(set.resolve(assignment).familyId, Provider.family.id)
    assert.equal((await set.load(assignment)).id, 'provider')
    await env.dispose()
  }
  assert.deepEqual(ids, ['provider', 'provider', 'provider'])

  // Error details keep their keys and read the family from either form.
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

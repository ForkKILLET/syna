// R01 / K06 — Binding.to default ranges and range validation at definition time.
import assert from 'node:assert/strict'
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'

let failures = 0
const report = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1 }
const check = (name, fn) => { try { fn(); report(name, true) } catch (error) { report(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error)) } }
const checkAsync = async (name, fn) => { try { await fn(); report(name, true) } catch (error) { report(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error)) } }

const shared = definePackage({ name: '@audit/sv-contract', version: '1.0.0', syna: { id: 'audit.sv.contract' } })
const Cap = shared.contract('cap')
const Choice = shared.binding('choice', Cap)
const Other = shared.contract('other')
const rev = version => definePackage({ name: '@audit/sv-impl', version, syna: { id: 'audit.sv.impl' } }).service('impl', { provides: [Cap], setup: () => ({ version }) })
const Consumer = shared.service('consumer', { requires: { chosen: Choice }, setup: ({ chosen }) => ({ chosen }) })
const Entry = shared.entry('entry', { requires: { consumer: Consumer }, parameters: { choice: Choice } })

async function resolved(admittedVersions, assignment) {
  const runtime = createRuntime({ services: [Consumer, ...admittedVersions.map(rev)] })
  try {
    const explanation = await runtime.explain(Entry, { choice: assignment })
    if (!explanation.ok) return { error: explanation.error.code, details: explanation.error.details }
    return explanation.parameters.bindingsResolved[Choice.id].split('@')[1]
  }
  finally { await runtime.dispose() }
}

// Default ranges
check('R01 Binding.to(0.2.0) defaults to ^0.2.0', () => assert.equal(Choice.to(rev('0.2.0')).version, '^0.2.0'))
check('R01 Binding.to(0.0.5) defaults to ^0.0.5', () => assert.equal(Choice.to(rev('0.0.5')).version, '^0.0.5'))
check('R01 Binding.to(2.4.1) defaults to ^2.4.1', () => assert.equal(Choice.to(rev('2.4.1')).version, '^2.4.1'))
check('K06 Binding.to(1.0.0-beta.1) defaults to ^1.0.0-beta.1', () => assert.equal(Choice.to(rev('1.0.0-beta.1')).version, '^1.0.0-beta.1'))

await checkAsync('R01 ^0.2.0 resolves among [0.1.9, 0.2.0, 0.2.5, 0.3.0] to 0.2.5 (never 0.1.x, never 0.3.0)', async () => assert.equal(await resolved(['0.1.9', '0.2.0', '0.2.5', '0.3.0'], Choice.to(rev('0.2.0'))), '0.2.5'))
await checkAsync('R01 ^0.2.0 with only lower published [0.1.9] is MISSING_IMPLEMENTATION, not relaxed downward', async () => {
  const result = await resolved(['0.1.9'], Choice.to(rev('0.2.0')))
  assert.equal(result.error, 'MISSING_IMPLEMENTATION'); assert.deepEqual(result.details.available, ['0.1.9'])
})
await checkAsync('R01 ^0.0.5 resolves among [0.0.4, 0.0.5, 0.0.6] to exactly 0.0.5', async () => assert.equal(await resolved(['0.0.4', '0.0.5', '0.0.6'], Choice.to(rev('0.0.5'))), '0.0.5'))
await checkAsync('R01 ^2.4.1 resolves among [2.0.0, 2.4.1, 2.9.0, 3.0.0] to 2.9.0 (never 2.0.0, never 3.0.0)', async () => assert.equal(await resolved(['2.0.0', '2.4.1', '2.9.0', '3.0.0'], Choice.to(rev('2.4.1'))), '2.9.0'))
await checkAsync('R01 ^2.4.1 with only [2.0.0, 3.0.0] admitted is MISSING_IMPLEMENTATION', async () => assert.equal((await resolved(['2.0.0', '3.0.0'], Choice.to(rev('2.4.1')))).error, 'MISSING_IMPLEMENTATION'))
await checkAsync('K06 prerelease: ^1.0.0-beta.1 among [1.0.0-beta.1, 1.0.0-beta.2, 1.0.0, 1.5.0, 2.0.0] picks 1.5.0', async () => assert.equal(await resolved(['1.0.0-beta.1', '1.0.0-beta.2', '1.0.0', '1.5.0', '2.0.0'], Choice.to(rev('1.0.0-beta.1'))), '1.5.0'))
await checkAsync('K06 prerelease: ^1.0.0-beta.1 among [1.0.0-alpha.1, 1.0.0-beta.1] picks 1.0.0-beta.1 (alpha is below the floor)', async () => assert.equal(await resolved(['1.0.0-alpha.1', '1.0.0-beta.1'], Choice.to(rev('1.0.0-beta.1'))), '1.0.0-beta.1'))
await checkAsync('K06 documented M-09: stable ^1.0.0 among [1.0.0, 1.1.0-rc.1] picks the admitted prerelease 1.1.0-rc.1 (includePrerelease)', async () => assert.equal(await resolved(['1.0.0', '1.1.0-rc.1'], Choice.to(rev('1.0.0'))), '1.1.0-rc.1'))
await checkAsync('K06 union: "1.x || 2.x" among [0.9.0, 1.2.0, 2.4.0, 3.0.0] picks 2.4.0', async () => assert.equal(await resolved(['0.9.0', '1.2.0', '2.4.0', '3.0.0'], Choice.to(rev('1.2.0'), '1.x || 2.x')), '2.4.0'))
await checkAsync('K06 comparator set: ">=1.2.0 <2.0.0 || >=3.0.0" among [1.9.0, 2.5.0, 3.1.0] picks 3.1.0', async () => assert.equal(await resolved(['1.9.0', '2.5.0', '3.1.0'], Choice.to(rev('1.2.0'), '>=1.2.0 <2.0.0 || >=3.0.0')), '3.1.0'))
await checkAsync('K06 exact revision assignment bypasses ranges', async () => assert.equal(await resolved(['2.4.1', '2.9.0'], rev('2.4.1')), '2.4.1'))
await checkAsync('K06 exact revision not admitted is MISSING_SERVICE', async () => assert.equal((await resolved(['2.9.0'], rev('2.4.1'))).error, 'MISSING_SERVICE'))

// Definition-time validation
check('K06 Binding.to(rev, invalid range) throws TypeError at definition time', () => assert.throws(() => Choice.to(rev('1.0.0'), 'definitely-not-a-range'), { name: 'TypeError', message: /not a valid semver range/ }))
check('K06 Binding.to(rev, "") throws at definition time', () => assert.throws(() => Choice.to(rev('1.0.0'), '   '), { name: 'TypeError' }))
check('K06 Service.range(invalid) throws TypeError at definition time', () => assert.throws(() => rev('1.0.0').range('>>1'), { name: 'TypeError', message: /not a valid semver range/ }))
check('K06 Binding.parse rejects invalid range', () => assert.throws(() => Choice.parse({ kind: 'persistent-implementation-ref', contractId: Cap.id, implementationId: 'audit.sv.impl', version: 'nope nope' }), { name: 'TypeError' }))
check('K06 Binding.parse rejects wrong contract', () => assert.throws(() => Choice.parse({ kind: 'persistent-implementation-ref', contractId: Other.id, implementationId: 'audit.sv.impl', version: '^1.0.0' }), { name: 'TypeError' }))
check('K06 Binding.to(service not providing the Contract) throws TypeError', () => {
  const NoCap = shared.service('nocap', { setup: () => ({}) })
  assert.throws(() => Choice.to(NoCap), { name: 'TypeError', message: /does not explicitly provide/ })
})
check('K06 package version must be complete semver (definePackage("2.4") throws)', () => assert.throws(() => definePackage({ name: 'x', version: '2.4', syna: { id: 'x' } }), { name: 'TypeError', message: /Invalid semantic version/ }))
check('K06 catalog persistentRef uses caret of the exact version', async () => {
  const runtime = createRuntime({ services: [rev('0.2.5')] })
  const [impl] = runtime.catalog.implementations(Cap)
  assert.equal(impl.persistentRef.version, '^0.2.5')
  await runtime.dispose()
})

console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

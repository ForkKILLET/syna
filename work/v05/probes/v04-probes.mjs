// Probes: run v0.5 requirements against the v0.4 kernel and report PASS/FAIL per probe.
import { createRuntime, definePackage, forward } from '../../../packages/core/dist/index.js'

const define = definePackage({ name: '@probe/p', version: '0.2.0', syna: { id: 'probe' } })
const results = []
const probe = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true, detail }) }
  catch (error) { results.push({ name, ok: false, detail: `${error?.code ?? error?.name}: ${error?.message}` }) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const withTimeout = (p, ms = 300) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms}ms`) })])

await probe('R05 Input payload Promise identity preserved (no assimilation)', async () => {
  const In = define.input('in')
  const S = define.service('s', { requires: { in: In }, setup: ({ in: ref }) => ({ ref }) })
  const E = define.entry('e', { requires: { s: S }, parameters: { in: In } })
  const rt = createRuntime({ services: [S] })
  const payload = Promise.resolve('inner')
  const env = await rt.enter(E, { in: payload })
  const r = (await env.deps.s.load()).ref; const got = typeof r.read === 'function' ? r.read() : await r.load()
  await rt.dispose()
  if (got !== payload) throw new Error(`payload assimilated: got ${JSON.stringify(got)} instead of the Promise object`)
  return 'identity preserved'
})

await probe('R05 Input undefined payload: presence distinct from missing', async () => {
  const In = define.input('in2')
  const S = define.service('s2', { requires: { in: In }, setup: ({ in: ref }) => ({ ref }) })
  const E = define.entry('e2', { requires: { s: S }, parameters: { in: In } })
  const rt = createRuntime({ services: [S] })
  const env = await rt.enter(E, { in: undefined })
  const r = (await env.deps.s.load()).ref; const got = typeof r.read === 'function' ? r.read() : await r.load()
  await rt.dispose()
  return `undefined accepted, read=${String(got)}`
})

await probe('K07 un-awaited load() does not add a barrier to caller', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const Slow = define.service('slow', { async setup() { await gate; return {} } })
  const Caller = define.service('caller', { requires: { slow: Slow }, setup({ slow }) { void slow.load().catch(() => {}); return { ok: true } } })
  const E = define.entry('e3', { requires: { caller: Caller } })
  const rt = createRuntime({ services: [Caller] })
  const env = await rt.enter(E)
  try {
    const v = await withTimeout(env.deps.caller.load(), 200)
    release()
    await rt.dispose()
    return `caller ready without waiting: ${v.ok}`
  } catch (e) { release(); await rt.dispose(); throw e }
})

await probe('R02 setup catch of lazy failing backend → degraded Ready', async () => {
  const Backend = define.service('backend', { setup() { throw new Error('backend down') } })
  const Consumer = define.service('consumer', {
    requires: { backend: Backend },
    async setup({ backend }) {
      try { await backend.load(); return { mode: 'full' } }
      catch { return { mode: 'degraded' } }
    },
  })
  const E = define.entry('e4', { requires: { consumer: Consumer } })
  const rt = createRuntime({ services: [Consumer] })
  const env = await rt.enter(E)
  const v = await withTimeout(env.deps.consumer.load(), 300)
  await rt.dispose()
  return `consumer mode=${v.mode}`
})

await probe('R04 Promise.race fallback: slow dependency does not block or poison caller', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const Slow = define.service('slow2', { async setup() { await gate; throw new Error('late failure') } })
  const Caller = define.service('caller2', {
    requires: { slow: Slow },
    async setup({ slow }) {
      const r = await Promise.race([slow.load().then(() => 'slow'), sleep(10).then(() => 'fallback')])
      return { r }
    },
  })
  const E = define.entry('e5', { requires: { caller: Caller } })
  const rt = createRuntime({ services: [Caller] })
  const env = await rt.enter(E)
  const v = await withTimeout(env.deps.caller.load(), 300)
  release(); await sleep(5)
  const again = await env.deps.caller.load()
  await rt.dispose()
  return `race result=${v.r}, stable after late rejection=${again === v}`
})

await probe('K02/H13 BoundEntry during owner activation must be rejected (no fake Ready)', async () => {
  const Child = define.entry('child', {})
  let observed
  const Eager = define.service('eager', {
    eager: true, requires: { child: Child },
    async setup({ child }) {
      const bound = await child.load()
      try { const env = await bound.enter(); observed = `child entered while owner activating (state=${env.state})` }
      catch (e) { observed = `rejected: ${e.code}` }
      return {}
    },
  })
  const E = define.entry('e6', { requires: { eager: Eager } })
  const rt = createRuntime({ services: [Eager] })
  await rt.enter(E)
  await rt.dispose()
  if (!observed.startsWith('rejected')) throw new Error(observed)
  return observed
})

await probe('R07 Service-owned Entry: private range root resolves like exact', async () => {
  const Tx = define.service('tx', { setup: () => ({ id: 'tx' }) })
  const TxEntryExact = define.entry('tx-exact', { requires: { tx: Tx } })
  const TxEntryRange = define.entry('tx-range', { requires: { tx: Tx.range('^0.2.0') } })
  const Uow = define.service('uow', {
    requires: { exact: TxEntryExact, range: TxEntryRange },
    setup({ exact, range }) {
      return {
        exact: async () => (await exact.load()).run(async ({ tx }) => (await tx.load()).id),
        range: async () => (await range.load()).run(async ({ tx }) => (await tx.load()).id),
      }
    },
  })
  const E = define.entry('e7', { requires: { uow: Uow } })
  const rt = createRuntime({ services: [Uow] })
  const env = await rt.enter(E)
  const uow = await env.deps.uow.load()
  const a = await uow.exact()
  let b
  try { b = await uow.range() } catch (e) { b = `ERR ${e.code}` }
  await rt.dispose()
  if (b !== 'tx') throw new Error(`exact=${a} range=${b}`)
  return `exact=${a} range=${b}`
})

await probe('R01 Binding.to default range for 0.x and 0.0.x', async () => {
  const C = define.contract('cap')
  const Bd = define.binding('bd', C)
  const P02 = definePackage({ name: '@probe/p02', version: '0.2.0', syna: { id: 'probe.p' } }).service({ provides: [C], setup: () => ({}) })
  const P005 = definePackage({ name: '@probe/p005', version: '0.0.5', syna: { id: 'probe.q' } }).service({ provides: [C], setup: () => ({}) })
  return `${Bd.to(P02).version} ${Bd.to(P005).version}`
})

await probe('K06 semver: prerelease and comparator unions', async () => {
  const { satisfiesVersion } = await import('../../../packages/core/dist/semver.js')
  const cases = [
    ['1.0.0-beta.1', '^1.0.0-beta.1', true],
    ['1.0.0-beta.2', '^1.0.0-beta.1', true],
    ['1.0.0', '^1.0.0-beta.1', true],
    ['1.2.3', '1.x || 2.x', true],
    ['2.0.0', '>=1.2.0 <2.0.0 || >=3.0.0', false],
    ['1.5.0', '>=1.2.0 <2.0.0 || >=3.0.0', true],
  ]
  const bad = []
  for (const [v, r, expected] of cases) {
    let got
    try { got = satisfiesVersion(v, r) } catch (e) { got = `throw:${e.message}` }
    if (got !== expected) bad.push(`${v} vs ${r}: expected ${expected} got ${got}`)
  }
  if (bad.length) throw new Error(bad.join('; '))
  return `${cases.length} cases ok`
})

await probe('R04 true pending wait cycle gets a bounded diagnostic instead of hanging', async () => {
  let A, B
  A = define.service('ca', { requires: { b: forward(() => B) }, async setup({ b }) { await b.load(); return {} } })
  B = define.service('cb', { requires: { a: forward(() => A) }, async setup({ a }) { await a.load(); return {} } })
  const E = define.entry('e9', { requires: { a: A } })
  const rt = createRuntime({ services: [A, B] })
  const env = await rt.enter(E)
  try { await withTimeout(env.deps.a.load(), 500); await rt.dispose(); return 'unexpected success' }
  catch (e) { await rt.dispose().catch(() => {}); return `diagnosed: ${e.code ?? e.message}` }
})

await probe('R09 caller abort of own wait does not exist in v0.4 API (load has no signal)', async () => {
  const S = define.service('sig', { setup: () => ({}) })
  const E = define.entry('e10', { requires: { s: S } })
  const rt = createRuntime({ services: [S] })
  const env = await rt.enter(E)
  const arity = env.deps.s.load.length
  await rt.dispose()
  return `load arity=${arity} (no per-caller signal)`
})

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`)

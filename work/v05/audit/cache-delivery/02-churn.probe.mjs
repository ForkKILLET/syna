// R18 / P04 — long churn. Run with: node --expose-gc 02-churn.probe.mjs
// 12,000 mixed operations (request Envs, BoundEntry enter/dispose, load({signal}) with a shared
// long-lived AbortSignal, deprecated selector open/dispose, C.all loads) against a ~120-service world.
// Watches runtime.inspect() (liveEnvCount, planCache, internalServices), heap after gc(), and the
// listener count on the shared AbortSignal. Then an LRU stress with 600 distinct Entry shapes under a
// 300-service parent to measure retained bytes per cached template (P06: key/template size).
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { auto, createRuntime, definePackage } from '../../../../packages/core/dist/index.js'

if (typeof globalThis.gc !== 'function') { console.log('FAIL needs --expose-gc'); process.exit(1) }
const gc = () => { for (let i = 0; i < 4; i += 1) globalThis.gc() }
const heap = () => { gc(); return process.memoryUsage().heapUsed }
let failures = 0
const report = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1 }
const check = (name, fn) => { try { fn(); report(name, true) } catch (error) { report(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error)) } }
const pkg = (id, version = '1.0.0') => definePackage({ name: `@audit/${id.replaceAll('.', '-')}`, version, syna: { id } })

function world(serviceCount) {
  const d = pkg(`audit.churn${serviceCount}`)
  const Request = d.input('request')
  const Tenant = d.input('tenant')
  const Capability = d.contract('capability')
  const Choice = d.binding('choice', Capability)
  const providers = [1, 2, 3].map(i => pkg(`audit.churn${serviceCount}.p${i}`).service({ provides: [Capability], setup: () => ({ i }) }))
  const Logger = d.service('logger', { setup: () => ({}) })
  const Pool = d.service('pool', { requires: { logger: Logger }, setup: () => ({}) })
  const stable = []
  for (let i = 0; i < Math.floor(serviceCount * 0.6); i += 1) {
    const previous = stable.at(-1)
    stable.push(d.service(`stable-${i}`, { requires: { pool: Pool, ...(previous ? { previous } : {}), ...(i % 5 === 0 ? { all: Capability.all } : {}), ...(i % 7 === 0 ? { choice: Choice } : {}) }, setup: () => ({}) }))
  }
  const tenantScoped = []
  for (let i = 0; i < Math.floor(serviceCount * 0.2); i += 1) {
    tenantScoped.push(d.service(`tenant-${i}`, { requires: { tenant: Tenant, stable: stable[i % stable.length], ...(i % 3 === 0 ? { automatic: auto(Capability) } : {}) }, setup: () => ({}) }))
  }
  const requestScoped = []
  for (let i = 0; i < serviceCount - stable.length - tenantScoped.length; i += 1) {
    const previous = requestScoped.at(-1)
    requestScoped.push(d.service(`request-${i}`, { requires: { request: Request, tenant: tenantScoped[i % tenantScoped.length], ...(previous ? { previous } : {}) }, setup: () => ({}) }))
  }
  const Tx = d.service('tx', { requires: { pool: Pool }, setup: () => ({}) })
  const TxEntry = d.entry('tx', { requires: { tx: Tx } })
  const Uow = d.service('uow', { requires: { tx: TxEntry }, setup: ({ tx }) => ({ tx }) })
  const Panel = d.service('panel', { requires: { legacy: Capability.selector, request: Request }, setup: ({ legacy }) => ({ legacy }) })
  const All = d.service('all-user', { requires: { all: Capability.all, request: Request }, setup: ({ all }) => ({ all }) })
  const App = d.entry('app', { requires: { pool: Pool, uow: Uow, ...Object.fromEntries(stable.map((s, i) => [`s${i}`, s])) }, parameters: { choice: Choice } })
  const Site = d.entry('site', { requires: Object.fromEntries(tenantScoped.map((s, i) => [`t${i}`, s])), parameters: { tenant: Tenant } })
  const Req = d.entry('request', { requires: { handler: requestScoped.at(-1), panel: Panel, all: All }, parameters: { request: Request } })
  const services = [Logger, Pool, ...providers, ...stable, ...tenantScoped, ...requestScoped, Uow, Panel, All]
  return { d, Request, Tenant, Capability, Choice, providers, Pool, App, Site, Req, services, requestScoped }
}

const policy = { orderAutoCandidates: (_c, candidates) => [...candidates].sort((l, r) => l.family.id.localeCompare(r.family.id)) }

// ---- Part 1: 12,000 mixed operations ------------------------------------------------------
{
  const w = world(120)
  const runtime = createRuntime({ services: w.services, planCache: { maxEntries: 64 }, policy })
  const app = await runtime.enter(w.App, { choice: w.Choice.to(w.providers[0]) })
  const site = await app.enter(w.Site, { tenant: 'churn' })
  const uow = await app.deps.uow.load()
  const sharedController = new AbortController()
  const total = 12_000
  const samples = []
  const baseline = runtime.inspect()
  let planCacheMax = 0
  let selectorOpens = 0
  let allLoads = 0
  for (let i = 0; i < total; i += 1) {
    switch (i % 4) {
      case 0: { const bound = await uow.tx.load(); const env = await bound.enter(); await env.deps.tx.load(); await env.dispose(); break }
      case 1: { const env = await site.enter(w.Req, { request: { i } }); await env.deps.handler.load({ signal: sharedController.signal }); await env.dispose(); break }
      case 2: {
        const env = await site.enter(w.Req, { request: { i } })
        const panel = await env.deps.panel.load()
        const legacy = await panel.legacy.load()
        const lease = await legacy.open(legacy.candidates[i % legacy.candidates.length])
        await lease.implementation.load()
        await lease.dispose()
        selectorOpens += 1
        await env.dispose()
        break
      }
      case 3: {
        const env = await site.enter(w.Req, { request: { i } })
        const all = await (await env.deps.all.load()).all.load()
        await all.load(all.candidates[i % all.candidates.length], { signal: sharedController.signal })
        allLoads += 1
        await env.dispose()
        break
      }
    }
    planCacheMax = Math.max(planCacheMax, runtime.inspect().planCache.entries)
    if (i % 2000 === 1999) {
      const inspection = runtime.inspect()
      samples.push({
        i: i + 1,
        heapUsed: heap(),
        liveEnvCount: inspection.liveEnvCount,
        planCacheEntries: inspection.planCache.entries,
        planCacheMisses: inspection.planCache.misses,
        planCacheEvictions: inspection.planCache.evictions,
        internalServices: inspection.internalServices.length,
        admittedServices: inspection.admittedServices.length,
        abortListeners: getEventListeners(sharedController.signal, 'abort').length,
        appChildren: app.inspect ? undefined : undefined,
      })
    }
  }
  const after = runtime.inspect()
  console.log(`churn samples: ${JSON.stringify(samples)}`)
  console.log(`churn planCache after: ${JSON.stringify(after.planCache)} planCacheMax=${planCacheMax} selectorOpens=${selectorOpens} allLoads=${allLoads}`)
  check('R18 liveEnvCount unchanged after 12,000 mixed operations', () => assert.equal(after.liveEnvCount, baseline.liveEnvCount))
  check('R18 rootEnvCount stays 1', () => assert.equal(after.rootEnvCount, 1))
  check('R18 plan-cache entries bounded and not growing after the first sample', () => {
    assert.ok(planCacheMax <= 16, `max=${planCacheMax}`)
    assert.equal(samples.at(-1).planCacheEntries, samples[0].planCacheEntries)
    assert.equal(samples.at(-1).planCacheMisses, samples[0].planCacheMisses, 'no new misses after warm-up')
  })
  check('R18 internal/admitted service registries unchanged', () => {
    assert.deepEqual(after.internalServices, baseline.internalServices)
    assert.deepEqual(after.admittedServices, baseline.admittedServices)
  })
  check('R18 shared AbortSignal accumulates no listeners across 6,000 load({signal}) calls', () => assert.equal(samples.at(-1).abortListeners, 0))
  check('R18 heap after gc() is flat over the last 4 samples (< 256 KiB drift)', () => {
    const tail = samples.slice(-4).map(s => s.heapUsed)
    const drift = Math.max(...tail) - Math.min(...tail)
    assert.ok(drift < 256 * 1024, `drift=${drift} bytes; samples=${tail.join(',')}`)
  })
  await runtime.dispose()
  check('R18 runtime.dispose() empties live Envs', () => assert.equal(runtime.inspect().liveEnvCount, 0))
}

// ---- Part 2: LRU stress with distinct shapes under a 300-service parent (template retained size) ----
{
  const w = world(300)
  const runtime = createRuntime({ services: w.services, policy }) // default maxEntries 512
  const app = await runtime.enter(w.App, { choice: w.Choice.to(w.providers[0]) })
  const site = await app.enter(w.Site, { tenant: 'lru' })
  const enterShape = async (k) => {
    const Entry = w.d.entry(`shape-${k}`, { requires: { handler: w.requestScoped.at(-1) }, parameters: { request: w.Request } })
    const env = await site.enter(Entry, { request: { k } })
    await env.dispose()
  }
  for (let k = 0; k < 20; k += 1) await enterShape(k)
  const before = heap()
  const entriesBefore = runtime.inspect().planCache.entries
  for (let k = 20; k < 512; k += 1) await enterShape(k)
  const atCapacity = heap()
  const statsAtCapacity = runtime.inspect().planCache
  for (let k = 512; k < 1100; k += 1) await enterShape(k)
  const afterEviction = heap()
  const statsAfter = runtime.inspect().planCache
  const perTemplate = (atCapacity - before) / (statsAtCapacity.entries - entriesBefore)
  console.log(`lru: entries ${entriesBefore}->${statsAtCapacity.entries}->${statsAfter.entries}, evictions=${statsAfter.evictions}, heap before=${before} atCapacity=${atCapacity} afterEviction=${afterEviction}, ~${Math.round(perTemplate)} bytes per template (includes compiler entry-registry growth)`)
  check('P04 LRU: entries capped at maxEntries=512 while 1,100 shapes were planned', () => { assert.equal(statsAfter.entries, 512); assert.ok(statsAfter.evictions >= 588, `evictions=${statsAfter.evictions}`) })
  check('P04 LRU: heap does not keep growing once the cache is full (< 1.5 MiB over 588 evicting shapes)', () => assert.ok(afterEviction - atCapacity < 1.5 * 1024 * 1024, `growth=${afterEviction - atCapacity}`))
  console.log(`NOTE retained per template ≈ ${Math.round(perTemplate / 1024)} KiB under a 300-service parent (key embeds the full parent graph signature)`)
  await runtime.dispose()
}

console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

// R17 — plan-cache neutrality. Identical operation sequences under
//   (a) planCache maxEntries 512, (b) maxEntries 1, (c) maxEntries 4 with interleaved
//   distinct-shape filler Entries forcing constant eviction
// must produce identical slot ownership (env.inspect()), identical explain() dispositions
// and causes, identical instance sharing, and identical error codes.
// Also: private-realm templates never serve a public caller; same Entry shape under two
// parents never shares Env-local slots; check()/explain() leave no live Envs or check-owned slots.
import assert from 'node:assert/strict'
import { auto, createRuntime, definePackage } from '../../../../packages/core/dist/index.js'

let failures = 0
const report = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}
const check = (name, fn) => {
  try { fn(); report(name, true) }
  catch (error) { report(name, false, error instanceof Error ? error.message.split('\n').slice(0, 3).join(' / ') : String(error)) }
}

const pkg = (id, version = '1.0.0') => definePackage({ name: `@audit/${id.replaceAll('.', '-')}`, version, syna: { id } })

function world() {
  const d = pkg('audit.cd')
  const Request = d.input('request')
  const Tenant = d.input('tenant')
  const Region = d.input('region')
  const Capability = d.contract('capability')
  const Choice = d.binding('choice', Capability)
  const ProviderA = pkg('audit.cd.a', '1.0.0').service({ provides: [Capability], setup: () => ({ id: 'a1' }) })
  const ProviderA2 = pkg('audit.cd.a', '2.0.0').service({ provides: [Capability], setup: () => ({ id: 'a2' }) })
  const ProviderB = pkg('audit.cd.b', '1.0.0').service({ provides: [Capability], setup: () => ({ id: 'b' }) })
  const Logger = d.service('logger', { setup: () => ({ log: [] }) })
  const Pool = d.service('pool', { requires: { logger: Logger }, setup: () => ({ pool: Symbol('pool') }) })
  const Cache = d.service('cache', { requires: { tenant: Tenant, pool: Pool }, setup: ({ tenant }) => ({ tenant: tenant.read() }) })
  const RequestAware = d.service('request-aware', { requires: { request: Request, cache: Cache, pool: Pool }, setup: ({ cache }) => ({ cache }) })
  const Panel = d.service('panel', { requires: { all: Capability.all, region: Region }, setup: ({ all }) => ({ all }) })
  const Auto = d.service('auto-user', { requires: { automatic: auto(Capability), pool: Pool }, setup: () => ({}) })
  const Chosen = d.service('chosen', { requires: { choice: Choice, cache: Cache }, setup: () => ({}) })
  const Tx = d.service('tx', { requires: { pool: Pool }, setup: () => ({}) })
  const TxEntry = d.entry('tx', { requires: { tx: Tx } })
  const Uow = d.service('uow', { requires: { tx: TxEntry, pool: Pool }, setup: ({ tx }) => ({ tx }) })
  const Secret = d.service('secret', { setup: () => ({ secret: true }) })
  const PrivateEntry = d.entry('private-entry', { requires: { secret: Secret } })
  const Owner = d.service('owner', { requires: { entry: PrivateEntry, secret: Secret }, setup: ({ entry }) => ({ entry }) })

  const App = d.entry('app', { requires: { pool: Pool, uow: Uow, owner: Owner }, parameters: { choice: Choice } })
  const Site = d.entry('site', { requires: { cache: Cache, panel: Panel }, parameters: { tenant: Tenant, region: Region } })
  const Layer = d.entry('layer', { requires: {}, parameters: { region: Region } })
  const reqRequires = { aware: RequestAware, chosen: Chosen, autoUser: Auto, panel: Panel }
  const Req = d.entry('request', { requires: reqRequires, parameters: { request: Request } })
  const ReqFresh = d.entry('request-fresh', { requires: reqRequires, parameters: { request: Request }, scope: { fresh: [Pool] } })
  const ReqShare = d.entry('request-share', { requires: reqRequires, parameters: { request: Request }, scope: { share: [Cache] } })
  const ReqBadShare = d.entry('request-bad-share', { requires: reqRequires, parameters: { request: Request, tenant: Tenant }, scope: { share: [Cache] } })
  const services = [Logger, Pool, Cache, RequestAware, Panel, Auto, Chosen, Uow, Owner, ProviderA, ProviderA2, ProviderB]
  return { d, Request, Tenant, Region, Capability, Choice, ProviderA, ProviderA2, ProviderB, Pool, Cache, Secret, PrivateEntry, App, Site, Layer, Req, ReqFresh, ReqShare, ReqBadShare, services }
}

const policy = {
  orderAutoCandidates: (_contract, candidates) => [...candidates].sort((l, r) => l.family.id.localeCompare(r.family.id) || r.version.localeCompare(l.version)),
}

/** Normalize an Env to a cache-independent structural record: owner role per node, dependency node ids, parent-slot identity. */
function record(env, roles) {
  const own = env.inspect()
  const slotToNode = new Map(own.nodes.map(node => [node.slotId, node.nodeId]))
  const parentNodes = env.parent ? undefined : undefined
  return own.nodes.map(node => ({
    node: node.nodeId,
    kind: node.kind,
    owner: roles.get(node.ownerEnvId) ?? (node.ownerEnvId === env.id ? 'self' : `UNKNOWN(${node.ownerEnvId})`),
    deps: Object.fromEntries(Object.entries(node.dependencies).map(([key, slotId]) => [key, slotToNode.get(slotId) ?? `EXTERNAL`])),
  }))
}

function recordExplanation(explanation) {
  if (!explanation.ok) return { ok: false, code: explanation.error.code, missingInputs: explanation.missingInputs, missingBindings: explanation.missingBindings }
  return {
    ok: true,
    services: explanation.services,
    inputs: explanation.inputs,
    synthetic: explanation.synthetic,
    choices: explanation.choices,
    nodes: explanation.nodes.map(node => ({ id: node.nodeId, disposition: node.disposition, cause: node.cause, path: node.path })),
  }
}

async function scenario(planCache, filler) {
  const w = world()
  const runtime = createRuntime({ services: w.services, planCache, policy })
  const fill = filler ? async (anchor, tag) => {
    for (let index = 0; index < 5; index += 1) {
      const F = w.d.entry(`filler-${tag}-${index}`, { requires: index % 2 === 0 ? { pool: w.Pool } : { cache: w.Cache } })
      try { const env = await anchor.enter(F); await env.dispose() } catch { /* filler under parents without Tenant is rejected; still exercises the cache */ }
    }
  } : async () => undefined
  const observed = []
  const roles = new Map()
  const push = (label, value) => observed.push([label, value])

  const app = await runtime.enter(w.App, { choice: w.Choice.to(w.ProviderA) })
  roles.set(app.id, 'app')
  const owner = await app.deps.owner.load()
  const appPool = await app.deps.pool.load()

  for (const round of [0, 1, 2]) {
    await fill(app, `r${round}`)
    const siteA = await app.enter(w.Site, { tenant: 'a', region: 'eu' })
    const siteB = await app.enter(w.Site, { tenant: 'b', region: 'us' })
    roles.set(siteA.id, 'siteA'); roles.set(siteB.id, 'siteB')
    const layerA = await siteA.enter(w.Layer, { region: 'eu' })  // same payload, explicit re-provision → Panel forks
    roles.set(layerA.id, 'layerA')
    push(`round${round}:siteA`, record(siteA, roles))
    push(`round${round}:layerA`, record(layerA, roles))
    push(`round${round}:layerA-explain`, recordExplanation(await siteA.explain(w.Layer, { region: 'eu' })))
    const cacheA = await siteA.deps.cache.load()
    const cacheB = await siteB.deps.cache.load()
    push(`round${round}:cache-tenants`, [cacheA.tenant, cacheB.tenant, cacheA === cacheB])

    for (const [anchorName, anchor, siteCache] of [['siteA', siteA, cacheA], ['siteB', siteB, cacheB], ['layerA', layerA, cacheA]]) {
      for (let index = 0; index < 2; index += 1) {
        for (const [entryName, Entry] of [['req', w.Req], ['fresh', w.ReqFresh], ['share', w.ReqShare]]) {
          await fill(anchor, `${anchorName}-${index}-${entryName}`)
          push(`round${round}:${anchorName}:${entryName}${index}:explain`, recordExplanation(await anchor.explain(Entry, { request: index })))
          const env = await anchor.enter(Entry, { request: index })
          roles.set(env.id, 'self')
          push(`round${round}:${anchorName}:${entryName}${index}:nodes`, record(env, roles))
          const aware = await env.deps.aware.load()
          const reqCache = await aware.cache.load()
          const reqPool = await (await env.deps.aware.load()).cache.load()
          push(`round${round}:${anchorName}:${entryName}${index}:identity`, {
            cacheIsSiteCache: reqCache === siteCache,
            cacheTenant: reqCache.tenant,
            panelAllCount: (await (await env.deps.panel.load()).all.load()).candidates.length,
          })
          void reqPool
          await env.dispose()
          roles.delete(env.id)
        }
        // bad share: re-providing Tenant forks Cache, so share:[Cache] must fail identically
        try {
          await anchor.enter(w.ReqBadShare, { request: index, tenant: 'other' })
          push(`round${round}:${anchorName}:badshare${index}`, 'NO-ERROR')
        }
        catch (error) { push(`round${round}:${anchorName}:badshare${index}`, error.code) }
        push(`round${round}:${anchorName}:badshare${index}:explain`, recordExplanation(await anchor.explain(w.ReqBadShare, { request: index, tenant: 'other' })))
      }
      // BoundEntry anchored at app via Uow
      const uow = await app.deps.uow.load()
      const bound = await uow.tx.load()
      const txEnv = await bound.enter()
      roles.set(txEnv.id, 'self')
      push(`round${round}:${anchorName}:bound`, record(txEnv, roles))
      push(`round${round}:${anchorName}:bound-pool`, (await (await txEnv.deps.tx.load()), true))
      await txEnv.dispose(); roles.delete(txEnv.id)
      // env.bind()
      const handle = anchor.bind(w.Req)
      const bEnv = await handle.enter({ request: 77 })
      roles.set(bEnv.id, 'self')
      push(`round${round}:${anchorName}:bind`, record(bEnv, roles))
      await bEnv.dispose(); roles.delete(bEnv.id)
      // private realm: owner path works, public path refuses, owner path still works
      push(`round${round}:${anchorName}:private-owner`, await (await owner.entry.load()).run(async ({ secret }) => (await secret.load()).secret))
      for (const attempt of [() => anchor.enter(w.PrivateEntry), () => anchor.bind(w.PrivateEntry).enter()]) {
        try { await attempt(); push(`round${round}:${anchorName}:private-public`, 'NO-ERROR') }
        catch (error) { push(`round${round}:${anchorName}:private-public`, error.code) }
      }
      push(`round${round}:${anchorName}:private-owner-again`, await (await owner.entry.load()).run(async ({ secret }) => (await secret.load()).secret))
    }
    push(`round${round}:pool-identity`, appPool === await app.deps.pool.load())
    await layerA.dispose(); await siteA.dispose(); await siteB.dispose()
    roles.delete(siteA.id); roles.delete(siteB.id); roles.delete(layerA.id)
  }
  // check()/explain() do not create Envs or leave check-owned slots
  const live = runtime.inspect().liveEnvCount
  for (let index = 0; index < 20; index += 1) {
    await app.check(w.Site, { tenant: `t${index}`, region: 'x' })
    await app.explain(w.Site, { tenant: `t${index}`, region: 'x' })
  }
  push('check-leaves-no-env', runtime.inspect().liveEnvCount === live)
  const probeSite = await app.enter(w.Site, { tenant: 'probe', region: 'x' })
  push('no-check-owned-slots', probeSite.inspect().nodes.every(node => !node.ownerEnvId.startsWith('check')))
  await probeSite.dispose()
  const stats = runtime.inspect().planCache
  await runtime.dispose()
  return { observed, stats }
}

const large = await scenario({ maxEntries: 512 }, false)
const tiny = await scenario({ maxEntries: 1 }, false)
const evicting = await scenario({ maxEntries: 4 }, true)

console.log(`stats large=${JSON.stringify(large.stats)}`)
console.log(`stats tiny=${JSON.stringify(tiny.stats)}`)
console.log(`stats evicting=${JSON.stringify(evicting.stats)}`)

check('R17 large cache actually hit templates', () => assert.ok(large.stats.hits > 50, `hits=${large.stats.hits}`))
check('R17 tiny cache actually evicted', () => assert.ok(tiny.stats.evictions > 50, `evictions=${tiny.stats.evictions}`))
check('R17 evicting cache with filler shapes evicted heavily', () => assert.ok(evicting.stats.evictions > tiny.stats.evictions / 2, `evictions=${evicting.stats.evictions}`))
check(`R17 maxEntries=1 sequence identical to maxEntries=512 (${large.observed.length} records)`, () => assert.deepEqual(tiny.observed, large.observed))
check('R17 constantly-evicting + filler sequence identical to maxEntries=512', () => assert.deepEqual(evicting.observed, large.observed))

const find = (label) => large.observed.find(([name]) => name === label)?.[1]
check('R17 same Entry shape under siteA/siteB uses each site\'s own Cache instance', () => {
  assert.equal(find('round0:siteA:req0:identity').cacheIsSiteCache, true)
  assert.equal(find('round0:siteB:req0:identity').cacheIsSiteCache, true)
  assert.equal(find('round0:siteA:req0:identity').cacheTenant, 'a')
  assert.equal(find('round0:siteB:req0:identity').cacheTenant, 'b')
})
check('R17 request nodes: Cache owned by the site, Pool by app, request-aware by self', () => {
  const nodes = find('round1:siteB:req1:nodes')
  const owner = id => nodes.find(node => node.node === id)?.owner
  assert.equal(owner('service:audit.cd/cache@1.0.0'), 'siteB')
  assert.equal(owner('service:audit.cd/pool@1.0.0'), 'app')
  assert.equal(owner('service:audit.cd/request-aware@1.0.0'), 'self')
  assert.equal(owner('all:audit.cd/capability/v1'), 'siteB')
})
check('R17 fresh:[Pool] forks Pool and its dependants (Cache, all providers) into the request', () => {
  const nodes = find('round0:siteA:fresh0:nodes')
  const owner = id => nodes.find(node => node.node === id)?.owner
  assert.equal(owner('service:audit.cd/pool@1.0.0'), 'self')
  assert.equal(owner('service:audit.cd/cache@1.0.0'), 'self')
  assert.equal(owner('service:audit.cd/logger@1.0.0'), 'app', 'Logger has no dependency on Pool and stays inherited')
  assert.equal(find('round0:siteA:fresh0:identity').cacheIsSiteCache, false)
})
check('R17 layer re-providing Region forks Panel but not Cache', () => {
  const nodes = find('round0:layerA')
  const owner = id => nodes.find(node => node.node === id)?.owner
  assert.equal(owner('service:audit.cd/panel@1.0.0'), 'layerA', 'Panel is owned by the layer itself (recorded under its role label)')
  assert.equal(owner('service:audit.cd/cache@1.0.0'), 'siteA')
  const explanation = find('round0:layerA-explain')
  assert.equal(explanation.nodes.find(node => node.id === 'service:audit.cd/panel@1.0.0').disposition, 'forked')
  assert.equal(explanation.nodes.find(node => node.id === 'service:audit.cd/panel@1.0.0').cause.kind, 'dependency-forked')
})
check('K12 share:[Cache] with re-provided Tenant reports SHARE_CONSTRAINT_FAILED (spec: constraint failures are not UNSAT) — enter and explain', () => {
  const entered = find('round0:siteA:badshare0')
  const explained = find('round0:siteA:badshare0:explain')
  assert.equal(entered, 'SHARE_CONSTRAINT_FAILED', `enter() threw ${entered}; explain() code ${explained.code}`)
  assert.equal(explained.code, 'SHARE_CONSTRAINT_FAILED')
})
check('R17 private realm never serves a public caller (enter and bind both MISSING_SERVICE) and owner path keeps working', () => {
  const publicAttempts = large.observed.filter(([name]) => name.endsWith(':private-public')).map(([, value]) => value)
  assert.ok(publicAttempts.length >= 18)
  assert.ok(publicAttempts.every(code => code === 'MISSING_SERVICE'), JSON.stringify(publicAttempts))
  assert.ok(large.observed.filter(([name]) => name.endsWith(':private-owner-again')).every(([, value]) => value === true))
})
check('R17 check()/explain() leave no live Env and no check-owned slots', () => {
  assert.equal(find('check-leaves-no-env'), true)
  assert.equal(find('no-check-owned-slots'), true)
})

// Differential dump for the report
if (failures > 0) {
  const diffAt = large.observed.findIndex((entry, index) => JSON.stringify(entry) !== JSON.stringify(tiny.observed[index]))
  if (diffAt >= 0) console.log(`first divergence (large vs tiny) at #${diffAt}: ${JSON.stringify(large.observed[diffAt]).slice(0, 400)} VS ${JSON.stringify(tiny.observed[diffAt]).slice(0, 400)}`)
}
console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

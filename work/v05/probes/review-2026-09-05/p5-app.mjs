// Issue 2 (app layer): tenant Env leak, eviction releasing capacity early, cache version race, disposal rejections.
import { override } from '../../../../packages/core/dist/index.js'
import { AuthOptions, AuthenticatorContract, SessionAuth, SiteAuth, defaultRecipes, define } from '../../../../apps/hyla-mini/dist/index.js'
import { AUTH, createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const mode = process.argv[2]
const unhandled = []
process.on('unhandledRejection', reason => { unhandled.push(reason?.message ?? String(reason)) })
const siteConfig = (tenantId, auth) => ({ tenantId, title: `Tenant ${tenantId}`, domains: [`${tenantId}.test`], defaultLocale: 'en', theme: { name: 'paper', accent: '#000000' }, navigation: [], recipes: defaultRecipes(), auth })

if (mode === 'leak') {
  const Broken = define.service('probe-broken-auth', { setup: () => ({ scheme: 'broken' }) })
  const harness = await createFilesystemApp({ app: { runtime: { overrides: [override(SessionAuth, Broken)] } } })
  const manager = await harness.app.app.deps.sites.load()
  const before = harness.app.runtime.inspect().liveEnvCount
  await manager.acquire('alpha', 'request').catch(e => console.log('acquire rejected:', e.constructor.name, e.message.slice(0, 60)))
  await sleep(20)
  const after = harness.app.runtime.inspect().liveEnvCount
  console.log('liveEnvCount before/after failed creation:', before, after, '| records:', manager.records().length)
  console.log(after === before ? 'PASS no env leaked' : 'FAIL a SiteEnv was entered, then dropped without dispose (leaked ' + (after - before) + ')')
  await harness.close()
}

if (mode === 'capacity') {
  const SlowDispose = define.service('probe-slow-dispose-auth', {
    provides: [AuthenticatorContract], requires: { options: AuthOptions },
    setup(_deps, { onDispose }) { onDispose(() => sleep(150)); return { scheme: 'slow-dispose', async authenticate() { return { kind: 'anonymous' } } } },
  })
  const harness = await createFilesystemApp({ app: { extraServices: [SlowDispose], siteManager: { capacity: 1, idleTtlMs: 60_000, acquireTimeoutMs: 2_000 } } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  for (const t of ['a', 'b', 'c']) await store.forTenant(t).saveSiteConfig(siteConfig(t, { implementation: SiteAuth.to(SlowDispose), options: {} }))
  const base = harness.app.runtime.inspect().liveEnvCount
  ;(await manager.acquire('a', 'request')).release()
  const samples = []
  const poll = setInterval(() => samples.push(harness.app.runtime.inspect().liveEnvCount - base), 5)
  const order = []
  const b = manager.acquire('b', 'request').then(l => { order.push('b'); return l })
  await sleep(5)
  const c = manager.acquire('c', 'request').then(l => { order.push('c'); return l })
  const lb = await b
  const peakBeforeC = Math.max(...samples)
  console.log('b acquired; peak live SiteEnvs so far (capacity 1):', peakBeforeC, '| records now:', manager.records().map(r => `${r.tenantId}:${r.state}`).join(','))
  lb.release()
  const lc = await c
  clearInterval(poll)
  console.log('order of acquisition:', order.join(' then '), '| peak live SiteEnvs:', Math.max(...samples))
  console.log(Math.max(...samples) <= 1 ? 'PASS working set never exceeded capacity' : 'FAIL working set exceeded capacity 1 (peak ' + Math.max(...samples) + '): capacity was released before the victim finished disposing')
  lc.release()
  await harness.close()
}

if (mode === 'cache') {
  const harness = await createFilesystemApp()
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  const repo = store.forTenant('alpha')
  const posts = await repo.listPosts({ visibility: 'public' })
  const post = posts.find(p => p.status === 'published')
  const lease = await manager.acquire('alpha', 'request')
  const context = lease.context
  const anonymous = { kind: 'anonymous' }
  const first = await context.renderPost(post.slug, anonymous)
  console.log('warm render contains original body:', first.html.includes(post.body.slice(0, 20)))
  // Interleave: renderPost reads the post, then reads the content version; a save lands in between.
  const realVersion = context.repository.contentVersion.bind(context.repository)
  let release
  const gate = new Promise(r => { release = r })
  context.repository.contentVersion = async () => { await gate; return realVersion() }
  const rendering = context.renderPost(post.slug, anonymous)
  await sleep(10)
  await repo.savePost({ ...post, body: 'UPDATED-BODY-MARKER' })
  release()
  await rendering
  context.repository.contentVersion = realVersion
  const later = await context.renderPost(post.slug, anonymous)
  console.log('page after the edit contains the new body:', later.html.includes('UPDATED-BODY-MARKER'), '| cache stats:', JSON.stringify(context.cacheStats))
  console.log(later.html.includes('UPDATED-BODY-MARKER') ? 'PASS' : 'FAIL stale post cached under the new content version (content read before version)')
  lease.release()
  await harness.close()
}

if (mode === 'dispose-reject') {
  const Throwing = define.service('probe-throwing-dispose-auth', {
    provides: [AuthenticatorContract], requires: { options: AuthOptions },
    setup(_deps, { onDispose }) { onDispose(() => { throw new Error('cleanup exploded') }); return { scheme: 'throwing', async authenticate() { return { kind: 'anonymous' } } } },
  })
  const harness = await createFilesystemApp({ app: { extraServices: [Throwing], siteManager: { capacity: 2, idleTtlMs: 60_000 } } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  await store.forTenant('x').saveSiteConfig(siteConfig('x', { implementation: SiteAuth.to(Throwing), options: {} }))
  const lease = await manager.acquire('x', 'request')
  lease.release()
  manager.invalidate('x')       // draining + idle → void disposeRecord() → env.dispose() rejects
  await sleep(30)
  console.log('unhandled rejections after invalidate():', JSON.stringify(unhandled))
  const swept = await manager.sweep().then(n => `sweep ok (${n})`, e => `sweep REJECTED: ${e.message.slice(0, 50)}`)
  console.log(swept)
  console.log(unhandled.length === 0 ? 'PASS' : 'FAIL a SiteEnv disposal failure became an unhandled rejection (process crash under the default policy)')
  await harness.close().catch(e => console.log('close rejected:', e.message.slice(0, 60)))
}

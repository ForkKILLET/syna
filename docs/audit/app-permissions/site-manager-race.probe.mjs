// Attack 3: site lease / configuration race, invalidate() semantics, capacity, single-flight failure, shutdown accounting.
import http from 'node:http'
import { AuthenticatorContract, AuthOptions, SiteAuth, SessionAuth, SignedTokenAuth, defaultRecipes, define, startHttpServer } from '../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 120_000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise(resolve => setImmediate(resolve))
  }
  return true
}
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))

/** An authenticator whose setup does real async work (like fetching JWKS). It widens the creation window deterministically. */
const SlowAuth = define.service('audit-slow-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    const delay = Number(options.read().delayMs ?? 40)
    await sleep(delay)
    return { scheme: 'slow', async authenticate() { return { kind: 'anonymous' } } }
  },
})

const SlowFailingAuth = define.service('audit-slow-failing-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    await sleep(Number(options.read().delayMs ?? 40))
    throw new TypeError('audit-slow-failing-auth always fails after async work')
  },
})

const siteConfig = (tenantId, auth, extra = {}) => ({
  tenantId, title: `Tenant ${tenantId}`, domains: [`${tenantId}.test`], defaultLocale: 'en', theme: { name: 'paper', accent: '#000000' },
  navigation: [], recipes: defaultRecipes(), auth, ...extra,
})

// ---------------------------------------------------------------- A. config change / invalidate while a SiteEnv is being created
{
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 3, idleTtlMs: 60_000, acquireTimeoutMs: 300, maxPendingAcquires: 4 }, extraServices: [SlowAuth] } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  const slow = store.forTenant('slow')
  await slow.saveSiteConfig(siteConfig('slow', { implementation: SiteAuth.to(SlowAuth), options: { delayMs: 60 } }))
  try {
    // A1: configuration bump while the first acquire is still creating the env.
    const first = manager.acquire('slow', 'request')
    const sawCreating = await until(() => manager.records().some(record => record.tenantId === 'slow' && record.state === 'creating'))
    check('A1 creation window observable (state=creating)', sawCreating, manager.records())
    const current = await slow.getSiteConfig()
    await slow.saveSiteConfig({ ...current, title: 'slow v2' })
    const second = manager.acquire('slow', 'request')
    const [firstResult, secondResult] = await Promise.all([settled(first), settled(second)])
    check('A1 both acquires succeed', firstResult.ok && secondResult.ok, { first: firstResult.ok ? firstResult.value.configRevision : String(firstResult.error), second: secondResult.ok ? secondResult.value.configRevision : String(secondResult.error) })
    if (firstResult.ok) firstResult.value.release()
    if (secondResult.ok) secondResult.value.release()
    await sleep(20)
    await manager.sweep()
    const afterA1 = manager.records().filter(record => record.tenantId === 'slow')
    check('A1 after release: at most one record for the tenant (old revision disposed, not stranded)', afterA1.length <= 1, afterA1)
    const stranded = afterA1.filter(record => record.state === 'draining' && record.leases === 0)
    check('A1 no draining record with zero leases left behind', stranded.length === 0, stranded)
    check('A1 liveEnvCount accounts only for records', harness.app.runtime.inspect().liveEnvCount === 2 + afterA1.length, { live: harness.app.runtime.inspect().liveEnvCount, records: afterA1.length })

    // A2: invalidate() while creating (no config change). Start on a fresh revision so A1's leftovers cannot mask it.
    const beforeA2 = await slow.getSiteConfig()
    await slow.saveSiteConfig({ ...beforeA2, title: 'slow v3' })
    const third = manager.acquire('slow', 'request')
    await until(() => manager.records().some(record => record.tenantId === 'slow' && record.state === 'creating'))
    manager.invalidate('slow')
    const thirdResult = await settled(third)
    check('A2 acquire started before invalidate() still yields a usable lease (or a fresh one)', thirdResult.ok, thirdResult.ok ? thirdResult.value.configRevision : String(thirdResult.error))
    if (thirdResult.ok) thirdResult.value.release()
    const fourthResult = await settled(manager.acquire('slow', 'request'))
    check('A2 acquire after invalidate() succeeds ("new acquires read the store again")', fourthResult.ok, fourthResult.ok ? fourthResult.value.configRevision : String(fourthResult.error))
    if (fourthResult.ok) fourthResult.value.release()
    const afterA2 = manager.records().filter(record => record.tenantId === 'slow')
    check('A2 no stranded draining record', !afterA2.some(record => record.state === 'draining' && record.leases === 0), afterA2)

    // A3: does the strand consume capacity that eviction cannot reclaim? capacity=3.
    const strandedNow = manager.records().filter(record => record.state === 'draining' && record.leases === 0).length
    const others = ['alpha', 'beta', 'slow'].map(tenantId => settled(manager.acquire(tenantId, 'request')))
    const results = await Promise.all(others)
    check('A3 three distinct tenants can still be acquired within capacity 3 (no phantom capacity use)', results.every(result => result.ok), results.map(result => result.ok ? result.value.key : String(result.error)))
    for (const result of results) if (result.ok) result.value.release()
    check('A3 stranded-record count for the record', true, { strandedNow, stats: manager.stats() })
  }
  finally {
    await harness.close()
  }
}

// ---------------------------------------------------------------- B. invalidate() while a lease is in flight (fast auth, no race needed)
{
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4 } } })
  const manager = await harness.app.app.deps.sites.load()
  try {
    const inFlight = await manager.acquire('alpha', 'request')
    manager.invalidate('alpha')
    const next = await settled(manager.acquire('alpha', 'request'))
    check('B invalidate() with an in-flight lease: the next acquire succeeds with a fresh env', next.ok && next.value.env !== inFlight.env, next.ok ? { sameEnv: next.value.env === inFlight.env } : String(next.error))
    if (next.ok) next.value.release()
    inFlight.release()
    await sleep(10)
    const after = await settled(manager.acquire('alpha', 'request'))
    check('B after the in-flight lease is released, acquire recovers', after.ok, after.ok ? after.value.configRevision : String(after.error))
    if (after.ok) after.value.release()
    check('B no stranded draining record', !manager.records().some(record => record.state === 'draining' && record.leases === 0), manager.records())
  }
  finally {
    await harness.close()
  }
}

// ---------------------------------------------------------------- C. storm: hold a lease, bump config N times, many concurrent acquirers
for (const variant of ['fast-auth', 'slow-auth']) {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 6, idleTtlMs: 60_000, acquireTimeoutMs: 2000, maxPendingAcquires: 200 }, extraServices: [SlowAuth] } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  const repository = store.forTenant('alpha')
  try {
    if (variant === 'slow-auth') {
      const current = await repository.getSiteConfig()
      await repository.saveSiteConfig({ ...current, auth: { implementation: SiteAuth.to(SlowAuth), options: { delayMs: 8 } } })
    }
    const held = await manager.acquire('alpha', 'request')
    let latestSaved = (await repository.getSiteConfig()).configRevision
    let maxRecords = 0
    let stale = 0
    const errors = []
    let stop = false
    const workers = Array.from({ length: 24 }, async () => {
      while (!stop) {
        const floor = latestSaved
        try {
          const lease = await manager.acquire('alpha', 'request')
          if (lease.configRevision < floor) stale += 1
          maxRecords = Math.max(maxRecords, manager.records().filter(record => record.tenantId === 'alpha').length)
          await sleep(1)
          lease.release()
        }
        catch (error) { errors.push(String(error.message)) }
      }
    })
    for (let round = 0; round < 12; round += 1) {
      await sleep(variant === 'slow-auth' ? 12 : 5)
      const current = await repository.getSiteConfig()
      const saved = await repository.saveSiteConfig({ ...current, title: `storm ${round}` })
      latestSaved = saved.configRevision
    }
    await sleep(60)
    stop = true
    await Promise.all(workers)
    held.release()
    await sleep(30)
    await manager.sweep()
    const records = manager.records().filter(record => record.tenantId === 'alpha')
    const stranded = records.filter(record => record.state === 'draining' && record.leases === 0)
    check(`C[${variant}] no acquire error during the storm`, errors.length === 0, errors.slice(0, 3))
    check(`C[${variant}] no acquire returned a revision older than one already saved when it started`, stale === 0, { stale })
    check(`C[${variant}] OBSERVE max concurrent alpha records (1 current + old revisions still leased in flight; bounded by capacity)`, maxRecords <= 6, { maxRecords })
    check(`C[${variant}] after the storm exactly one alpha record remains (current revision, active)`, records.length === 1 && records[0].configRevision === latestSaved && records[0].state === 'active', records)
    check(`C[${variant}] no stranded draining records`, stranded.length === 0, stranded)
    check(`C[${variant}] leases fully released`, manager.stats().leases === 0, manager.stats())
    check(`C[${variant}] live Envs = infrastructure + app + records`, harness.app.runtime.inspect().liveEnvCount === 2 + records.length, { live: harness.app.runtime.inspect().liveEnvCount, records: records.length })
  }
  finally {
    await harness.close()
  }
}

// ---------------------------------------------------------------- D. capacity: leased envs are never evicted; waiters get released capacity
{
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 250, maxPendingAcquires: 1 } } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  await store.forTenant('gamma').saveSiteConfig(siteConfig('gamma', { implementation: SiteAuth.to(SessionAuth), options: {} }))
  try {
    const a = await manager.acquire('alpha', 'request')
    const b = await manager.acquire('beta', 'request')
    const waiting = settled(manager.acquire('gamma', 'request'))
    await sleep(10)
    const overflow = await settled(manager.acquire('gamma', 'build'))
    check('D queue bound: second waiter rejected with SITE_CAPACITY', !overflow.ok && overflow.error.code === 'SITE_CAPACITY', overflow.ok ? 'ok' : overflow.error.code)
    const timedOut = await waiting
    check('D waiter times out rather than evicting a leased env', !timedOut.ok && timedOut.error.code === 'SITE_CAPACITY', timedOut.ok ? 'ok' : timedOut.error.message)
    check('D leased envs intact', manager.records().every(record => record.state === 'active' && record.leases === 1) && manager.records().length === 2, manager.records())
    const waiting2 = settled(manager.acquire('gamma', 'request'))
    await sleep(5)
    a.release()
    const granted = await waiting2
    check('D releasing a lease hands capacity to the waiter', granted.ok && granted.value.tenantId === 'gamma', granted.ok ? granted.value.key : String(granted.error))
    check('D capacity respected after hand-over', manager.stats().records <= 2, manager.stats())
    if (granted.ok) granted.value.release()
    b.release()
    a.release(); a.release()
    check('D double release does not go negative', manager.stats().leases === 0 && manager.records().every(record => record.leases >= 0), manager.stats())
  }
  finally {
    await harness.close()
  }
}

// ---------------------------------------------------------------- E. failing creation: single-flight, no poison, per-tenant backoff, HTTP mapping
{
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, creationBackoffMs: 80, creationBackoffMaxMs: 200 }, extraServices: [SlowFailingAuth] } })
  const manager = await harness.app.app.deps.sites.load()
  const store = await harness.app.app.deps.store.load()
  const broken = store.forTenant('broken')
  await broken.saveSiteConfig(siteConfig('broken', { implementation: SiteAuth.to(SignedTokenAuth), options: {} }))
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains })
  try {
    const burst = await Promise.all(Array.from({ length: 6 }, () => settled(manager.acquire('broken', 'request'))))
    check('E all concurrent acquirers of a failing creation get the error', burst.every(result => !result.ok && /secret/.test(result.error.message)), burst.map(result => result.ok ? 'ok' : result.error.message.slice(0, 60)))
    check('E single-flight: exactly one creation failure counted', manager.stats().creationFailures === 1, manager.stats().creationFailures)
    check('E no poisoned record', manager.records().filter(record => record.tenantId === 'broken').length === 0, manager.records())
    const backoff = await settled(manager.acquire('broken', 'request'))
    check('E immediate retry is refused by backoff', !backoff.ok && /backing off/.test(backoff.error.message), backoff.ok ? 'ok' : backoff.error.message.slice(0, 80))
    const unaffected = await settled(manager.acquire('beta', 'request'))
    check('E other tenants unaffected by the backoff', unaffected.ok, unaffected.ok ? unaffected.value.key : String(unaffected.error))
    if (unaffected.ok) unaffected.value.release()
    const viaHttp = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.port, path: '/', headers: { host: 'broken.test' } }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
      request.end()
    })
    check('E HTTP maps a backing-off tenant to a 5xx', viaHttp.status >= 500, viaHttp.status)
    check('E HTTP body does not echo internal configuration diagnostics to anonymous clients', !/secret|backing off/.test(viaHttp.body), viaHttp.body.slice(0, 120))
    // contrast: a creation that fails only after real async work lets concurrent acquirers join one attempt
    const slowBroken = store.forTenant('slowbroken')
    await slowBroken.saveSiteConfig(siteConfig('slowbroken', { implementation: SiteAuth.to(SlowFailingAuth), options: { delayMs: 40 } }))
    const failuresBefore = manager.stats().creationFailures
    const slowBurst = await Promise.all(Array.from({ length: 6 }, () => settled(manager.acquire('slowbroken', 'request'))))
    check('E contrast: 6 concurrent acquirers of a SLOW failing creation share one attempt (creationFailures +1)', slowBurst.every(result => !result.ok) && manager.stats().creationFailures === failuresBefore + 1, { delta: manager.stats().creationFailures - failuresBefore })
    await sleep(260) // > creationBackoffMaxMs so recovery is tested independently of the inflated counter
    const current = await broken.getSiteConfig()
    await broken.saveSiteConfig({ ...current, auth: { ...current.auth, options: { secret: 'fixed' } } })
    const recovered = await settled(manager.acquire('broken', 'request'))
    check('E recovers after the configuration is fixed', recovered.ok, recovered.ok ? recovered.value.configRevision : String(recovered.error))
    if (recovered.ok) recovered.value.release()
  }
  finally {
    await server.close()
    await harness.close()
  }
}

// ---------------------------------------------------------------- F. shutdown accounting
{
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, shutdownTimeoutMs: 120 } } })
  const manager = await harness.app.app.deps.sites.load()
  const a = await manager.acquire('alpha', 'request')
  const b = await manager.acquire('beta', 'build')
  const b2 = await manager.acquire('beta', 'request')
  const started = Date.now()
  const shutdownPromise = manager.shutdown()
  const during = await settled(manager.acquire('alpha', 'request'))
  check('F acquire during shutdown refused with SITE_MANAGER_CLOSED', !during.ok && during.error.code === 'SITE_MANAGER_CLOSED', during.ok ? 'ok' : during.error.code)
  const report = await shutdownPromise
  const elapsed = Date.now() - started
  check('F shutdown waited up to the timeout then reported unreleased leases per record', report.unreleasedLeases.length === 2 && report.unreleasedLeases.some(item => item.endsWith('#2')) && elapsed >= 100, { report, elapsed })
  check('F records disposed after shutdown', manager.stats().records === 0, manager.stats())
  a.release(); b.release(); b2.release(); b2.release()
  check('F late releases do not go negative or throw', manager.stats().leases === 0, manager.stats())
  const secondReport = await manager.shutdown()
  check('F shutdown is idempotent', secondReport.unreleasedLeases.length === 0, secondReport)
  // app.close() path: the report from onDispose is discarded, so the host cannot see it.
  const harness2 = await createFilesystemApp({ app: { siteManager: { shutdownTimeoutMs: 60 } } })
  const manager2 = await harness2.app.app.deps.sites.load()
  const leaked = await manager2.acquire('alpha', 'request')
  const t = Date.now()
  const closeResult = await harness2.close()
  check('F app.close() with a leaked lease resolves (after the shutdown timeout) but returns no unreleased-lease report to the host', closeResult === undefined && Date.now() - t >= 50, { closeResult, elapsed: Date.now() - t, envState: leaked.env.state })
  await harness.close()
}

clearTimeout(watchdog)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
process.exitCode = failed === 0 ? 0 : 1

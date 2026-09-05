// F-AP3-05 (docs): HYLA_MINI.md says retries while acquiring are "以 acquireTimeoutMs 为界" (bounded by
// acquireTimeoutMs). The loop's deadline is checked only when it decides to retry, and every capacity wait
// starts a fresh `acquireTimeoutMs` timer, so an acquire that is granted a unit late, finds its generation
// moved (invalidate() during the wait), and queues again can take ~2× acquireTimeoutMs before SITE_CAPACITY.
import { SessionAuth, SiteAuth, defaultRecipes, loadContentFixture, siteConfigInputFromFixture } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const TIMEOUT = 400

const harness = await createFilesystemApp({ app: { siteManager: { capacity: 1, idleTtlMs: 60_000, sweepIntervalMs: 60_000, acquireTimeoutMs: TIMEOUT } } })
try {
  const store = await harness.app.app.deps.store.load()
  const fixture = loadContentFixture()
  await store.forTenant('gamma').saveSiteConfig({ ...siteConfigInputFromFixture('gamma', fixture.tenants.alpha, { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }), domains: ['gamma.test'] })
  const manager = await harness.app.app.deps.sites.load()

  const holder = await manager.acquire('alpha', 'request') // the only unit
  const started = Date.now()
  const waiting = manager.acquire('beta', 'request').then(lease => { lease.release(); return 'lease' }, error => error.code) // waiter 1
  await sleep(20)
  const other = manager.acquire('gamma', 'request') // waiter 2, behind beta; it will HOLD its lease until beta's acquire has ended
  await sleep(TIMEOUT * 0.8)
  manager.invalidate('beta') // beta's generation moves while its acquirer waits
  holder.release() // → beta's waiter is granted, sees the moved generation, releases the unit (gamma gets it) and re-queues with a fresh timer
  const outcome = await waiting
  const elapsed = Date.now() - started
  check('the beta acquirer ends with SITE_CAPACITY (gamma holds the only unit)', outcome === 'SITE_CAPACITY', outcome)
  check(`the beta acquire took at most acquireTimeoutMs (+25%) = ${TIMEOUT * 1.25} ms as documented`, elapsed <= TIMEOUT * 1.25, { elapsedMs: elapsed, acquireTimeoutMs: TIMEOUT, outcome })
  ;(await other).release()
}
finally {
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

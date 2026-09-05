// F-AP3-03: `reserveCapacity()` calls `evictIdle()` for every purpose before queueing, but a build/background
// acquirer may only take a unit while MORE than `reservedForRequests` units are free. With one unit held by a
// request lease (capacity 2, reserve 1) a build can never be served, yet each build attempt closes the
// longest-idle SiteEnv of another tenant (a warm cache) for nothing, and the next request for that tenant
// pays a cold creation. `release()` has the `waiterServable(free + 1)` guard; `reserveCapacity()` does not.
import { SessionAuth, SiteAuth, defaultRecipes, loadContentFixture, siteConfigInputFromFixture } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, idleTtlMs: 60_000, sweepIntervalMs: 60_000, acquireTimeoutMs: 150 } } })
try {
  const store = await harness.app.app.deps.store.load()
  const fixture = loadContentFixture()
  await store.forTenant('gamma').saveSiteConfig({ ...siteConfigInputFromFixture('gamma', fixture.tenants.alpha, { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }), domains: ['gamma.test'] })
  const manager = await harness.app.app.deps.sites.load()
  check('reservedForRequests defaults to 1 at capacity 2', manager.settings.reservedForRequests === 1)

  const held = await manager.acquire('alpha', 'request') // one unit: a long request on alpha
  const beta = await manager.acquire('beta', 'request')  // the other unit: beta, released → warm idle SiteEnv
  beta.release()
  const before = manager.stats()
  check('setup: two records, beta idle, alpha leased', before.records === 2 && before.idle === 1 && before.active === 1, before)

  // A build for a third tenant can never be served while alpha's lease holds the last unit (D43).
  const attempts = 3
  for (let round = 1; round <= attempts; round += 1) {
    const outcome = await manager.acquire('gamma', 'build').then(lease => { lease.release(); return 'served' }, error => error.code)
    check(`build attempt ${round} is refused for capacity (design: a build never takes the last unit)`, outcome === 'SITE_CAPACITY', outcome)
    // Between attempts, a request re-creates beta's world (as live traffic would) so the next build has an idle victim again.
    const again = await manager.acquire('beta', 'request')
    again.release()
  }
  const after = manager.stats()
  check(`no idle SiteEnv was evicted by builds that could not be served (evictions stayed ${before.evictions})`, after.evictions === before.evictions, { evictionsBefore: before.evictions, evictionsAfter: after.evictions })
  check(`beta's SiteEnv was not re-created ${attempts} times because of the refused builds (creations)`, after.creations === before.creations, { creationsBefore: before.creations, creationsAfter: after.creations })
  held.release()
}
finally {
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

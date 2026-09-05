// S2: capacity 2, two acquirers of one new tenant and one of another: the third must not starve behind a redundant reservation.
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
import { SessionAuth, SiteAuth, defaultRecipes, siteConfigInputFromFixture, loadContentFixture } from '../../../../apps/hyla-mini/dist/index.js'
const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, idleTtlMs: 60_000, acquireTimeoutMs: 3_000 } } })
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
try {
  const store = await harness.app.app.deps.store.load()
  const fixture = loadContentFixture()
  for (const tenantId of ['x-tenant', 'y-tenant']) {
    await store.forTenant(tenantId).saveSiteConfig({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }), domains: [`${tenantId}.test`] })
  }
  const manager = await harness.app.app.deps.sites.load()
  const started = Date.now()
  const results = await Promise.allSettled([manager.acquire('x-tenant', 'request'), manager.acquire('x-tenant', 'request'), manager.acquire('y-tenant', 'request')])
  const elapsed = Date.now() - started
  check('all three acquirers are served', results.every(result => result.status === 'fulfilled'), results.map(result => result.status === 'fulfilled' ? result.value.tenantId : result.reason.code))
  check('within a second (not by the acquire timeout)', elapsed < 1_000, elapsed)
  check('two SiteEnvs were created, nobody was rejected for capacity', manager.stats().creations === 2 && manager.stats().rejectedForCapacity === 0, manager.stats())
  for (const result of results) if (result.status === 'fulfilled') result.value.release()
}
finally {
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

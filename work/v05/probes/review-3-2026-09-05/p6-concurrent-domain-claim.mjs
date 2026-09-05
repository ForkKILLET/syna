// B2: two tenants claiming one domain at the same time: exactly one may win (filesystem backend; PostgreSQL when SYNA_TEST_PG_URL is set).
import { createFilesystemApp, createPostgresApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
import { SessionAuth, SiteAuth, defaultRecipes, loadContentFixture, siteConfigInputFromFixture } from '../../../../apps/hyla-mini/dist/index.js'
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const fixture = loadContentFixture()
const extras = { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }
async function probe(label, harness) {
  try {
    const store = await harness.app.app.deps.store.load()
    const base = tenantId => ({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, extras), domains: [] })
    await store.forTenant('claim-a').saveSiteConfig(base('claim-a'))
    await store.forTenant('claim-b').saveSiteConfig(base('claim-b'))
    let wins = 0
    for (let round = 0; round < 5; round += 1) {
      const host = `contested-${round}.test`
      const results = await Promise.allSettled([
        store.forTenant('claim-a').saveSiteConfig({ ...base('claim-a'), domains: [host] }),
        store.forTenant('claim-b').saveSiteConfig({ ...base('claim-b'), domains: [host.toUpperCase()] }),
      ])
      wins = results.filter(result => result.status === 'fulfilled').length
      if (wins !== 1) { check(`${label}: round ${round} has exactly one winner`, false, results.map(result => result.status === 'fulfilled' ? 'won' : result.reason.name)); break }
    }
    if (wins === 1) check(`${label}: five rounds, exactly one winner each`, true)
    await store.deleteTenant('claim-a')
    await store.deleteTenant('claim-b')
  }
  finally {
    await harness.close()
  }
}
await probe('filesystem', await createFilesystemApp())
if (process.env.SYNA_TEST_PG_URL) await probe('postgres', await createPostgresApp())
else console.log('postgres: skipped (SYNA_TEST_PG_URL not set)')
process.exitCode = failed === 0 ? 0 : 1

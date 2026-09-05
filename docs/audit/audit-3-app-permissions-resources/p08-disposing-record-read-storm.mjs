// F-AP3-08: while a SiteEnv is closing (record state `disposing`, key still in the map), an acquirer of the
// same key neither joins nor replaces it: `acquire()` hits `record.state !== 'active'` and `continue`s,
// re-reading the tenant's configuration on every turn until the close settles (or the deadline expires).
// A slow close (a Service cleanup that takes a while, bounded by the Runtime's disposal grace) thus turns
// each waiting request into a loop of store reads, and the tenant answers SITE_CAPACITY (503) after
// `acquireTimeoutMs` although capacity is free and nothing is wrong with the tenant.
import { AuthOptions, AuthenticatorContract, SiteAuth, defaultRecipes, define, loadContentFixture, siteConfigInputFromFixture } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const CLOSE_MS = 600

/** An authenticator whose cleanup takes CLOSE_MS (a connection drain, a flush): the SiteEnv closes slowly. */
const SlowCloseAuth = define.service('audit3-slow-close-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup(_deps, { onDispose }) {
    onDispose(() => sleep(CLOSE_MS))
    return { scheme: 'slow-close', async authenticate() { return { kind: 'anonymous' } } }
  },
})

for (const acquireTimeoutMs of [300, 2_000]) {
  const harness = await createFilesystemApp({ app: { extraServices: [SlowCloseAuth], siteManager: { capacity: 4, idleTtlMs: 0, sweepIntervalMs: 60_000, acquireTimeoutMs } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const fixture = loadContentFixture()
    await store.forTenant('slow').saveSiteConfig({ ...siteConfigInputFromFixture('slow', fixture.tenants.alpha, { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SlowCloseAuth), options: {} } }), domains: ['slow.test'] })
    const manager = await harness.app.app.deps.sites.load()
    // Count the manager's configuration reads of tenant `slow`.
    let reads = 0
    const realForTenant = store.forTenant.bind(store)
    store.forTenant = tenantId => {
      const real = realForTenant(tenantId)
      return { ...real, async getSiteConfig() { if (tenantId === 'slow') reads += 1; return real.getSiteConfig() } }
    }

    const first = await manager.acquire('slow', 'request')
    first.release()
    const sweeping = manager.sweep() // idleTtlMs 0: the idle SiteEnv starts closing now (takes CLOSE_MS)
    await sleep(5)
    check(`[timeout ${acquireTimeoutMs}] the record is disposing`, manager.records().find(r => r.tenantId === 'slow')?.state === 'disposing', manager.records())
    reads = 0
    const started = Date.now()
    const outcome = await manager.acquire('slow', 'request').then(lease => { lease.release(); return 'lease' }, error => error.code)
    const elapsed = Date.now() - started
    await sweeping
    console.log(`info [timeout ${acquireTimeoutMs}] acquire during a ${CLOSE_MS} ms close: outcome ${outcome} after ${elapsed} ms, configuration reads meanwhile: ${reads}, stats ${JSON.stringify(manager.stats())}`)
    check(`[timeout ${acquireTimeoutMs}] the acquirer does not spin on configuration reads while the close is in flight (≤ 5 reads)`, reads <= 5, { reads, elapsed })
    if (acquireTimeoutMs < CLOSE_MS) check(`[timeout ${acquireTimeoutMs}] with 3 free units the tenant is not refused for capacity`, outcome === 'lease', { outcome, freeUnits: manager.settings.capacity - manager.stats().records })
    else check(`[timeout ${acquireTimeoutMs}] the acquirer is served once the close settled`, outcome === 'lease', outcome)
    store.forTenant = realForTenant
  }
  finally {
    await harness.close()
  }
}
process.exitCode = failed === 0 ? 0 : 1

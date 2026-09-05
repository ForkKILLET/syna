// F-AP3-04: `shutdown()` reaching a `creating` record whose `enter()` has not returned yet runs
// `disposeRecord()` with `record.env` still undefined: the disposal resolves at once, the record is dropped,
// and when `enter()` returns the creator sees `record.disposal` and only awaits it ("a shutdown already took
// the record; it closes the Env") — nobody closes that Env. It stays alive after `manager.shutdown()` resolved
// and is only reaped by the Runtime's own disposal. HYLA_MINI.md: "创建在 Env 进入之后失败（…管理器已关闭等）时，
// 那个 Env 立即关闭而不是泄漏".
import { AuthOptions, AuthenticatorContract, SiteAuth, defaultRecipes, define, loadContentFixture, siteConfigInputFromFixture } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Same idea as the audit-app SlowAuth fixture: setup takes a while, which widens the `enter()` window. */
const SlowAuth = define.service('audit3-slow-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    await sleep(Number(options.read().delayMs ?? 300))
    return { scheme: 'slow', async authenticate() { return { kind: 'anonymous' } } }
  },
})

const harness = await createFilesystemApp({ app: { extraServices: [SlowAuth], siteManager: { capacity: 4, shutdownTimeoutMs: 20, sweepIntervalMs: 60_000 } } })
try {
  const store = await harness.app.app.deps.store.load()
  const fixture = loadContentFixture()
  await store.forTenant('slow').saveSiteConfig({ ...siteConfigInputFromFixture('slow', fixture.tenants.alpha, { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SlowAuth), options: { delayMs: 300 } } }), domains: ['slow.test'] })
  const manager = await harness.app.app.deps.sites.load()
  const runtime = harness.app.runtime
  const liveBefore = runtime.inspect().liveEnvCount

  const acquiring = manager.acquire('slow', 'request').then(lease => { lease.release(); return 'lease' }, error => error.code)
  await sleep(60) // inside enter(): SlowAuth's setup is running, record.env is still undefined
  const creatingRecord = manager.records().find(record => record.tenantId === 'slow')
  check('the record is `creating` while enter() runs', creatingRecord?.state === 'creating', creatingRecord)
  const started = Date.now()
  const report = await manager.shutdown()
  const shutdownMs = Date.now() - started
  check('shutdown() returned before enter() finished (creation still in flight)', shutdownMs < 250, { shutdownMs, report })
  const outcome = await acquiring
  check('the acquirer is refused with SITE_MANAGER_CLOSED', outcome === 'SITE_MANAGER_CLOSED', outcome)
  await sleep(20)
  const liveAfter = runtime.inspect().liveEnvCount
  check('no SiteEnv is alive after shutdown() + the refused acquire (the manager closed the Env it entered)', liveAfter === liveBefore, { liveBefore, liveAfter, records: manager.records(), stats: manager.stats() })
  const closeReport = await harness.app.close()
  check('control: the Runtime disposal reaps it (close() reports nothing)', closeReport.errors.length === 0 && runtime.inspect().liveEnvCount === 0, closeReport)
}
finally {
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

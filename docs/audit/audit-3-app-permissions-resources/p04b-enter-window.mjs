// Companion of p04: can `shutdown()` land while `enter()` of a creating record is still pending (record.env
// undefined)? Measures the enter() duration of a SiteEnv and tries to hit the window from a macrotask
// (setImmediate) with `shutdownTimeoutMs: 0`. If enter() resolves within microtasks the window is unreachable
// from outside the manager and F-AP3-04's "orphaned Env" variant stays reasoning-only.
import { SiteEntry, SessionAuth, SiteAuth } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, shutdownTimeoutMs: 0, sweepIntervalMs: 60_000 } } })
try {
  const store = await harness.app.app.deps.store.load()
  const config = await store.forTenant('alpha').getSiteConfig()
  const bound = await harness.app.app.deps.sites.load() && await (async () => harness.app.app)()
  // 1. How long does enter() of a site world take, and does it start any service eagerly?
  const samples = []
  for (let i = 0; i < 5; i += 1) {
    const t = process.hrtime.bigint()
    const env = await bound.enter(SiteEntry, { tenant: 'alpha', snapshot: config, auth: SiteAuth.to(SessionAuth), authOptions: config.auth.options })
    samples.push(Number(process.hrtime.bigint() - t) / 1e6)
    await env.dispose()
  }
  console.log(`info enter(SiteEntry) durations ms: ${samples.map(s => s.toFixed(2)).join(', ')}`)
  // Does the promise of enter() settle within the microtask queue (no macrotask hop)?
  let settledInMicrotasks = false
  const pending = bound.enter(SiteEntry, { tenant: 'alpha', snapshot: config, auth: SiteAuth.to(SessionAuth), authOptions: config.auth.options })
  pending.then(() => { settledInMicrotasks = true })
  await new Promise(resolve => setImmediate(resolve))
  console.log(`info enter() settled before the next macrotask: ${settledInMicrotasks}`)
  await (await pending).dispose()

  // 2. Try to hit the window: poll records() from setImmediate and shut down the moment a `creating` record shows.
  const manager = await harness.app.app.deps.sites.load()
  const runtime = harness.app.runtime
  const liveBefore = runtime.inspect().liveEnvCount
  const acquiring = manager.acquire('beta', 'request').then(lease => { lease.release(); return 'lease' }, error => error.code)
  let seenCreating = false
  for (let i = 0; i < 10_000; i += 1) {
    await new Promise(resolve => setImmediate(resolve))
    const record = manager.records().find(r => r.tenantId === 'beta')
    if (record?.state === 'creating') { seenCreating = true; break }
    if (record) break
  }
  // Shut down either way: with the window hit, `creating`; otherwise a control over an idle record.
  const shutdownPromise = manager.shutdown()
  const outcome = await acquiring
  const report = await shutdownPromise
  await sleep(20)
  const liveAfter = runtime.inspect().liveEnvCount
  console.log(`info creating-record observed: ${seenCreating}; acquire outcome: ${outcome}; shutdown report: ${JSON.stringify(report)}`)
  check('no SiteEnv outlives manager.shutdown() (liveEnvCount unchanged)', liveAfter === liveBefore, { liveBefore, liveAfter, seenCreating, outcome })
}
finally {
  await harness.close()
}
process.exitCode = failed === 0 ? 0 : 1

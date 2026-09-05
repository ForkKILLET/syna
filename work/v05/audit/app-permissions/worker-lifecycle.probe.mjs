// Attack 11: worker start after Ready, runtime.dispose() while running, start() twice, start()/stop() race.
import { createFilesystemApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A. dispose while running
{
  const harness = await createFilesystemApp({ app: { siteManager: { idleTtlMs: 5, sweepIntervalMs: 60_000 } } })
  const worker = await harness.app.app.deps.worker.load()
  const manager = await harness.app.app.deps.sites.load()
  check('A idle before start', worker.state === 'idle')
  const lease = await manager.acquire('alpha', 'request')
  lease.release()
  await worker.start({ intervalMs: 5 })
  check('A running with one extra child Env', worker.state === 'running' && harness.app.runtime.inspect().liveEnvCount === 4, harness.app.runtime.inspect().liveEnvCount)
  const twice = await settled(worker.start())
  check('A start() twice rejects while running', !twice.ok && /running/.test(twice.error.message), twice.ok ? 'started' : twice.error.message)
  await sleep(40)
  check('A ticks progress and the idle site env got swept', worker.ticks >= 2 && manager.records().length === 0, { ticks: worker.ticks, records: manager.records().length })
  const started = Date.now()
  const disposed = await Promise.race([settled(harness.app.runtime.dispose()), sleep(5000).then(() => ({ ok: false, error: new Error('dispose hung >5s') }))])
  check('A runtime.dispose() while the worker is running completes', disposed.ok, disposed.ok ? `${Date.now() - started}ms` : disposed.error.message)
  check('A worker stopped by disposal', worker.state === 'stopped', worker.state)
  check('A no live Envs (worker child gone)', harness.app.runtime.inspect().liveEnvCount === 0, harness.app.runtime.inspect().liveEnvCount)
  const ticksAfter = worker.ticks
  await sleep(30)
  check('A loop really ended (no ticks after disposal)', worker.ticks === ticksAfter, { ticksAfter, now: worker.ticks })
  const late = await settled(worker.start({ intervalMs: 5 }))
  check('A start() after disposal is refused and leaves state stopped', !late.ok && worker.state !== 'running', { ok: late.ok, code: late.error?.code ?? late.error?.message, state: worker.state })
  await harness.close()
}

// B. stop() issued while start() is still opening the child world
{
  const harness = await createFilesystemApp({ app: { siteManager: { sweepIntervalMs: 60_000 } } })
  const worker = await harness.app.app.deps.worker.load()
  const startPromise = worker.start({ intervalMs: 5 })
  const stopPromise = worker.stop() // start() has not yet flipped to 'running': stop() sees 'idle'
  const [startResult, stopResult] = await Promise.all([settled(startPromise), settled(stopPromise)])
  await sleep(40)
  check('B stop() issued during start(): both settle', startResult.ok && stopResult.ok, { start: startResult.ok ? 'ok' : startResult.error.message, stop: stopResult.ok ? 'ok' : stopResult.error.message })
  check('B a stop() issued during start() wins: the worker is not running afterwards', worker.state !== 'running' && worker.ticks === 0, { state: worker.state, ticks: worker.ticks, liveEnvs: harness.app.runtime.inspect().liveEnvCount })
  await worker.stop()
  check('B after an explicit stop() the child world is released', worker.state === 'stopped' && harness.app.runtime.inspect().liveEnvCount === 2, harness.app.runtime.inspect().liveEnvCount)
  // restart after stop
  await worker.start({ intervalMs: 5 })
  await sleep(20)
  check('B restart after stop works', worker.state === 'running' && worker.ticks >= 1)
  await worker.stop()
  await worker.stop()
  check('B stop() is idempotent', worker.state === 'stopped')
  await harness.close()
}

clearTimeout(watchdog)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
process.exitCode = failed === 0 ? 0 : 1

// Independent-audit probes, reference application (A1, A2, A3), reconstructed from
// SYNA_RC3_EXECUTION_PROMPT.md §2.4–2.5 because work/rc3/audit/ was not present in
// the workspace (see work/rc3/BASELINE.md). Each probe asserts that the DEFECT is
// present; they are the baseline, not tests.
// Run: node work/rc3/probes/site-manager.mjs
import { createFilesystemApp } from '../../../apps/multitenant-blog/tests/helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const settledWithin = async (promise, ms) => {
  const marker = Symbol('pending')
  const result = await Promise.race([promise.then(value => ({ value }), error => ({ error })), sleep(ms).then(() => marker)])
  return result === marker ? undefined : result
}

/** Gates every getSiteConfig() of one store, exactly as the site-manager tests do. */
function gateConfigReads(store) {
  const gates = new Map()
  const entry = tenantId => {
    let gate = gates.get(tenantId)
    if (!gate) {
      let open
      const opened = new Promise(resolve => { open = resolve })
      gate = { opened, open, waiting: 0, isOpen: false }
      gates.set(tenantId, gate)
    }
    return gate
  }
  const realForTenant = store.forTenant.bind(store)
  store.forTenant = tenantId => {
    const repository = realForTenant(tenantId)
    return {
      ...repository,
      async getSiteConfig() {
        const config = await repository.getSiteConfig()
        const gate = entry(tenantId)
        if (!gate.isOpen) {
          gate.waiting += 1
          await gate.opened
        }
        return config
      },
    }
  }
  return {
    waiting: tenantId => entry(tenantId).waiting,
    open(tenantId) { const gate = entry(tenantId); gate.isOpen = true; gate.open() },
    restore() { store.forTenant = realForTenant },
  }
}

/**
 * A1: the owner's abort sets `closed` before the cleanup runs, so `shutdown()`
 * skips its whole tail — the sweep interval is never cleared and queued
 * acquirers are never rejected.
 */
async function probeA1() {
  const intervals = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (callback, ms, ...rest) => {
    const entry = { cleared: false, fired: 0 }
    entry.handle = realSetInterval((...args) => { entry.fired += 1; return callback(...args) }, ms, ...rest)
    intervals.push(entry)
    return entry.handle
  }
  globalThis.clearInterval = handle => {
    for (const entry of intervals) if (entry.handle === handle) entry.cleared = true
    return realClearInterval(handle)
  }
  let harness
  try {
    harness = await createFilesystemApp({
      app: { siteManager: { capacity: 1, idleTtlMs: 60_000, acquireTimeoutMs: 30_000, shutdownTimeoutMs: 100, sweepIntervalMs: 30 } },
    })
    const manager = await harness.app.app.deps.sites.load()
    const held = await manager.acquire('alpha', 'request')
    const queued = manager.acquire('beta', 'request').then(lease => { lease.release(); return 'acquired' }, error => error.code ?? error.name)
    while (manager.stats().pendingAcquires === 0) await sleep(5)
    const sweeper = intervals.at(-1)
    const firedBeforeClose = sweeper.fired
    // Only the Runtime is disposed: the owner's abort listener runs before the cleanup.
    await harness.app.runtime.dispose().catch(() => undefined)
    const queuedOutcome = await settledWithin(queued, 200)
    const firedAfterClose = sweeper.fired
    await sleep(100)
    held.release()
    return {
      id: 'A1',
      title: 'after an owner abort, shutdown() skips clearInterval (the sweeper survives the close)',
      reproduced: !sweeper.cleared && sweeper.fired > firedAfterClose,
      detail: `intervals created=${intervals.length}, cleared=${intervals.filter(entry => entry.cleared).length}; the sweeper fired ${firedBeforeClose} times before the close and ${sweeper.fired > firedAfterClose ? `is still firing after it (${firedAfterClose} → ${sweeper.fired})` : `has not fired since (${firedAfterClose} → ${sweeper.fired})`}; the queued acquirer ${queuedOutcome === undefined ? 'is still waiting' : `settled with ${JSON.stringify(queuedOutcome)}`}`,
      cleanup: async () => { await harness.close().catch(() => undefined) },
    }
  }
  finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

/** A2: `acquireTimeoutMs` does not cover the configuration read, so a blocked store blocks acquire() without bound. */
async function probeA2() {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 200 } } })
  const store = await harness.app.app.deps.store.load()
  const manager = await harness.app.app.deps.sites.load()
  const gates = gateConfigReads(store)
  const started = Date.now()
  const acquiring = manager.acquire('alpha', 'request').then(lease => { lease.release(); return 'acquired' }, error => error.code ?? error.name)
  while (gates.waiting('alpha') === 0) await sleep(5)
  const outcome = await settledWithin(acquiring, 1_200)
  return {
    id: 'A2',
    title: 'acquireTimeoutMs does not cover the configuration read',
    reproduced: outcome === undefined,
    detail: `acquireTimeoutMs=200 ms; after ${Date.now() - started} ms acquire() is ${outcome === undefined ? 'still waiting on the store' : `settled with ${JSON.stringify(outcome)}`}`,
    cleanup: async () => {
      gates.open('alpha')
      await acquiring.catch(() => undefined)
      gates.restore()
      await harness.close().catch(() => undefined)
    },
  }
}

/** A3: `shutdown()` does not end the wait of a caller that is inside the configuration read. */
async function probeA3() {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 2, acquireTimeoutMs: 30_000, shutdownTimeoutMs: 100 } } })
  const store = await harness.app.app.deps.store.load()
  const manager = await harness.app.app.deps.sites.load()
  const gates = gateConfigReads(store)
  const acquiring = manager.acquire('alpha', 'request').then(lease => { lease.release(); return 'acquired' }, error => error.code ?? error.name)
  while (gates.waiting('alpha') === 0) await sleep(5)
  const shutdownStarted = Date.now()
  await manager.shutdown()
  const shutdownMs = Date.now() - shutdownStarted
  const outcome = await settledWithin(acquiring, 800)
  return {
    id: 'A3',
    title: 'shutdown() leaves in-flight callers waiting on the store',
    reproduced: outcome === undefined,
    detail: `shutdown() returned after ${shutdownMs} ms; the in-flight acquirer is ${outcome === undefined ? 'still waiting' : `settled with ${JSON.stringify(outcome)}`}`,
    cleanup: async () => {
      gates.open('alpha')
      await acquiring.catch(() => undefined)
      gates.restore()
      await harness.close().catch(() => undefined)
    },
  }
}

const probes = [probeA1, probeA2, probeA3]
let failed = 0
for (const probe of probes) {
  const result = await probe()
  if (!result.reproduced) failed += 1
  console.log(`PROBE ${result.id} ${result.reproduced ? 'REPRODUCED' : 'NOT-REPRODUCED'} — ${result.title}`)
  console.log(`    ${result.detail}`)
  await result.cleanup?.()
}
console.log(`application probes: ${probes.length - failed}/${probes.length} reproduced`)
process.exit(failed === 0 ? 0 : 1)

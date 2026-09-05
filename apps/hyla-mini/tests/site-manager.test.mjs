// H10 / H11 / P05 — SiteEnvs are a bounded, leased working set with version rotation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SessionAuth, SiteAuth, defaultRecipes } from '../dist/index.js'
import { createFilesystemApp, fixture } from './helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function addTenants(store, count) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const tenantId = `t${String(index).padStart(3, '0')}`
    ids.push(tenantId)
    const repository = store.forTenant(tenantId)
    await repository.saveSiteConfig({
      tenantId,
      title: `Tenant ${index}`,
      domains: [`${tenantId}.test`],
      defaultLocale: 'en',
      theme: { name: 'paper', accent: '#000000' },
      navigation: [],
      recipes: defaultRecipes(),
      auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } },
    })
    await repository.savePost({
      id: `${tenantId}-p1`, slug: 'first', locale: 'en', title: `First of ${tenantId}`, body: `Hello from ${tenantId}`,
      status: 'published', categories: [], tags: [], createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    })
  }
  return ids
}

test('H10 leases are single-flight per key, idempotent on release, evicted only when idle, and bounded by capacity with backpressure', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 3, idleTtlMs: 60_000, maxPendingAcquires: 2, acquireTimeoutMs: 300 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const tenants = await addTenants(store, 6)
    const manager = await harness.app.app.deps.sites.load()

    const leases = await Promise.all(Array.from({ length: 5 }, () => manager.acquire(tenants[0], 'request')))
    assert.equal(manager.stats().creations, 1, 'concurrent first acquires share one creation')
    assert.ok(leases.every(lease => lease.env === leases[0].env))
    assert.equal(manager.stats().leases, 5)
    leases[0].release()
    leases[0].release()
    leases[0].release()
    assert.equal(manager.stats().leases, 4, 'release is idempotent and never negative')
    for (const lease of leases.slice(1)) lease.release()
    assert.equal(manager.stats().leases, 0)

    const held = [await manager.acquire(tenants[1], 'request'), await manager.acquire(tenants[2], 'request')]
    assert.equal(manager.stats().records, 3)
    // Capacity reached: the idle tenant 0 env is evicted to make room for tenant 3.
    const fourth = await manager.acquire(tenants[3], 'request')
    assert.equal(manager.stats().evictions, 1)
    assert.deepEqual(manager.records().map(record => record.tenantId).sort(), [tenants[1], tenants[2], tenants[3]])

    // All three are leased: further tenants queue (bounded) and time out instead of evicting a live tenant.
    const started = Date.now()
    const waitingA = manager.acquire(tenants[4], 'request').catch(error => error)
    const waitingB = manager.acquire(tenants[5], 'request').catch(error => error)
    await sleep(10)
    assert.equal(manager.stats().pendingAcquires, 2)
    await assert.rejects(manager.acquire(tenants[0], 'request'), error => error.code === 'SITE_CAPACITY')
    fourth.release()
    const resultA = await waitingA
    assert.equal(resultA.tenantId, tenants[4], 'a released env made room; the waiter proceeded')
    const resultB = await waitingB
    assert.equal(resultB.code, 'SITE_CAPACITY', 'the second waiter timed out')
    assert.ok(Date.now() - started >= 250)
    assert.equal(manager.stats().records, 3)
    assert.deepEqual(manager.records().filter(record => record.leases > 0).map(record => record.tenantId).sort(), [tenants[1], tenants[2], tenants[4]])
    for (const lease of [...held, resultA]) lease.release()
    assert.ok(manager.stats().rejectedForCapacity >= 2)
  }
  finally {
    await harness.close()
  }
})

test('H10 configuration update under traffic: new requests enter the new revision, in-flight requests finish on the old one, old envs are released and never accumulate', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 8, idleTtlMs: 60_000 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const repository = store.forTenant('alpha')
    const inFlight = await manager.acquire('alpha', 'request')
    assert.equal(inFlight.context.site.title, 'Alpha Notes')

    for (let round = 1; round <= 5; round += 1) {
      const current = await repository.getSiteConfig()
      await repository.saveSiteConfig({ ...current, title: `Alpha Notes v${round}` })
      const fresh = await manager.acquire('alpha', 'request')
      assert.equal(fresh.context.site.title, `Alpha Notes v${round}`, 'new requests see the new revision')
      assert.equal(fresh.configRevision, current.configRevision + 1)
      fresh.release()
    }
    assert.equal(inFlight.context.site.title, 'Alpha Notes', 'the in-flight request keeps its snapshot')
    const records = manager.records().filter(record => record.tenantId === 'alpha')
    assert.ok(records.length <= 2, `old revisions must not accumulate: ${JSON.stringify(records)}`)
    assert.ok(records.some(record => record.state === 'draining' && record.leases === 1))
    inFlight.release()
    await sleep(5)
    const after = manager.records().filter(record => record.tenantId === 'alpha')
    assert.equal(after.length, 1)
    assert.equal(after[0].state, 'active')
    assert.equal(after[0].configRevision, inFlight.configRevision + 5)
    assert.ok(manager.stats().evictions === 0, 'version rotation is not eviction')
  }
  finally {
    await harness.close()
  }
})

test('H10 a cold creation failure leaves no poisoned single-flight promise and backs off; shutdown refuses new acquires and reports unreleased leases', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, creationBackoffMs: 50, creationBackoffMaxMs: 200, shutdownTimeoutMs: 100 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const repository = store.forTenant('broken')
    await repository.saveSiteConfig({
      tenantId: 'broken', title: 'Broken', domains: ['broken.test'], defaultLocale: 'en', theme: { name: 'paper', accent: '#000' }, navigation: [],
      recipes: defaultRecipes(),
      auth: { implementation: { kind: 'persistent-implementation-ref', contractId: SiteAuth.contract.id, implementationId: 'hyla.mini/signed-token-auth', version: '*' }, options: {} },
    })
    await assert.rejects(manager.acquire('broken', 'request'), /secret/)
    assert.equal(manager.stats().creationFailures, 1)
    assert.equal(manager.records().filter(record => record.tenantId === 'broken').length, 0, 'no poisoned record remains')
    await assert.rejects(manager.acquire('broken', 'request'), /backing off/)
    assert.equal(manager.stats().creationFailures, 1, 'the retry storm is throttled')
    await sleep(60)
    const current = await repository.getSiteConfig()
    await repository.saveSiteConfig({ ...current, auth: { ...current.auth, options: { secret: 'now-fine' } } })
    const recovered = await manager.acquire('broken', 'request')
    assert.equal(recovered.context.site.title, 'Broken')
    assert.equal(manager.stats().creationFailures, 1)

    await assert.rejects(manager.acquire('unknown-tenant', 'request'), error => error.code === 'UNKNOWN_TENANT')

    const shutdown = manager.shutdown()
    await assert.rejects(manager.acquire('alpha', 'request'), error => error.code === 'SITE_MANAGER_CLOSED')
    const report = await shutdown
    assert.equal(report.unreleasedLeases.length, 1, 'the still-held lease is reported, not silently killed')
    assert.equal(manager.stats().records, 0)
    recovered.release()
  }
  finally {
    await harness.close()
  }
})

test('H11 / P05 working set stays bounded under hot-spot, rotating and long-tail access with many tenants; heap trend is sampled after GC', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 6, idleTtlMs: 40, sweepIntervalMs: 20 } } })
  try {
    const store = await harness.app.app.deps.store.load()
    const tenants = await addTenants(store, 120)
    const manager = await harness.app.app.deps.sites.load()
    assert.equal(manager.stats().records, 0, 'unvisited tenants have no Env')

    const heapSamples = []
    const sampleHeap = label => {
      if (typeof globalThis.gc === 'function') globalThis.gc()
      heapSamples.push({ label, heapUsed: process.memoryUsage().heapUsed, records: manager.stats().records, liveEnvs: harness.app.runtime.inspect().liveEnvCount })
    }
    sampleHeap('start')
    const maxRecords = { hot: 0, rotate: 0, tail: 0, mixed: 0 }
    const touch = async (tenantId, phase) => {
      const lease = await manager.acquire(tenantId, 'request')
      await lease.context.renderIndex({ kind: 'anonymous' })
      maxRecords[phase] = Math.max(maxRecords[phase], manager.stats().records)
      lease.release()
    }
    // Hot spot: 3 tenants, 300 requests.
    for (let index = 0; index < 300; index += 1) await touch(tenants[index % 3], 'hot')
    sampleHeap('after-hot')
    // Rotation across 120 tenants twice.
    for (let round = 0; round < 2; round += 1) for (const tenantId of tenants) await touch(tenantId, 'rotate')
    sampleHeap('after-rotation')
    // Long tail with concurrency and a config change under traffic.
    await Promise.all(tenants.slice(0, 40).map(async (tenantId, index) => {
      await touch(tenantId, 'tail')
      if (index === 5) {
        const repository = store.forTenant(tenants[0])
        const current = await repository.getSiteConfig()
        await repository.saveSiteConfig({ ...current, title: 'rotated under traffic' })
      }
      await touch(tenants[0], 'tail')
    }))
    sampleHeap('after-tail')
    for (let index = 0; index < 200; index += 1) await touch(tenants[(index * 7) % 120], 'mixed')
    sampleHeap('after-mixed')
    await sleep(80)
    await manager.sweep()
    sampleHeap('after-idle-sweep')

    const stats = manager.stats()
    for (const phase of Object.keys(maxRecords)) assert.ok(maxRecords[phase] <= 6, `${phase} exceeded capacity: ${maxRecords[phase]}`)
    assert.equal(stats.records, 0, 'idle envs are evicted by TTL')
    assert.equal(harness.app.runtime.inspect().liveEnvCount, 2, 'only infrastructure and app envs remain')
    assert.ok(stats.evictions > 100)
    assert.equal(stats.leases, 0)
    assert.equal(stats.pendingAcquires, 0)
    const first = heapSamples[1].heapUsed
    const last = heapSamples.at(-1).heapUsed
    assert.ok(last < first * 1.5 + 20_000_000, `heap did not stay bounded: ${JSON.stringify(heapSamples)}`)
    const report = {
      generatedAt: new Date().toISOString(),
      tenants: tenants.length,
      capacity: 6,
      maxRecordsPerPhase: maxRecords,
      finalStats: stats,
      planCache: harness.app.runtime.inspect().planCache,
      heapSamples,
      gcExposed: typeof globalThis.gc === 'function',
    }
    // The orchestrator points this at validation/v0.5-<mode>/working-set.json; a
    // plain test run writes under work/ so it never dirties tracked files.
    const outFile = path.resolve(process.env.SYNA_WORKING_SET_OUT ?? path.join('work', 'v05', 'working-set.json'))
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`)
  }
  finally {
    await harness.close()
  }
})

test('H11 shutdown with concurrent acquire/release: no acquire after close, every lease accounted for', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { capacity: 4, shutdownTimeoutMs: 200 } } })
  const manager = await harness.app.app.deps.sites.load()
  const outcomes = []
  const workers = Array.from({ length: 12 }, async (_, index) => {
    for (let round = 0; round < 20; round += 1) {
      try {
        const lease = await manager.acquire(index % 2 === 0 ? 'alpha' : 'beta', 'request')
        await sleep(1)
        lease.release()
        outcomes.push('ok')
      }
      catch (error) {
        outcomes.push(error.code ?? error.message)
        return
      }
    }
  })
  await sleep(15)
  const report = await manager.shutdown()
  await Promise.all(workers)
  assert.equal(report.unreleasedLeases.length, 0)
  assert.ok(outcomes.includes('ok'))
  assert.ok(outcomes.every(outcome => outcome === 'ok' || outcome === 'SITE_MANAGER_CLOSED'), JSON.stringify(outcomes))
  assert.equal(manager.stats().records, 0)
  await harness.close()
  void fixture
})

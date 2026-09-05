// Attack 4 (PostgreSQL): one shared pg.Pool per app, owned once, ended exactly once; no site/request/build Env owns a pool slot.
// Run wrapped: SYNA_PG_CLUSTER_DIR=... node scripts/pg-test-cluster.mjs with -- node work/v05/audit/app-permissions/pool-sharing.probe.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  BuildEntry, DatabasePool, PROBE_REQUEST, PipelineBuilder, Renderer, RequestEntry, RequestHandler, SessionAuth, SignedTokenAuth,
  SiteContext, StaticBuilder, STAGE_FACTORIES, define, startHttpServer,
} from '../../../../apps/hyla-mini/dist/index.js'
import { createPostgresApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 90_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))

// Count pools created and ended by the application (same `pg` module instance as apps/hyla-mini/dist).
let created = 0
let ended = 0
const OriginalPool = pg.Pool
class CountingPool extends OriginalPool {
  constructor(...args) { super(...args); created += 1 }
  end(...args) { ended += 1; return super.end(...args) }
}
pg.Pool = CountingPool

const harness = await createPostgresApp()
const app = harness.app
const buildDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-pool-build-'))
try {
  const domains = await app.domains()
  const server = await startHttpServer({ app: app.app, domains })
  const statuses = []
  for (const host of ['alpha.test', 'beta.test']) {
    for (const route of ['/', '/posts/shared-slug', '/site.json', '/category/notes']) {
      statuses.push((await fetchText(`${server.url}${route}`, { headers: { host } })).status)
    }
  }
  await server.close()
  check('requests to both tenants succeed', statuses.every(status => status === 200), statuses)
  check('exactly one pg.Pool created for the whole app (harness seeding + 8 requests + 2 tenants)', created === 1, { created })

  const manager = await app.app.deps.sites.load()
  const alpha = await manager.acquire('alpha', 'request')
  const beta = await manager.acquire('beta', 'request')
  const requestEnv = await alpha.env.enter(RequestEntry, { request: PROBE_REQUEST })
  const buildEnv = await beta.env.enter(BuildEntry, { build: { outputDir: buildDir } })
  const inspections = {
    infrastructure: app.infrastructure.inspect(),
    app: app.app.inspect(),
    siteAlpha: alpha.env.inspect(),
    siteBeta: beta.env.inspect(),
    request: requestEnv.inspect(),
    build: buildEnv.inspect(),
  }
  const poolSlots = new Map()
  for (const inspection of Object.values(inspections)) {
    for (const node of inspection.nodes) if (node.label === DatabasePool.key) poolSlots.set(node.slotId, node.ownerEnvId)
  }
  check('exactly one DatabasePool slot across infrastructure/app/site/request/build Envs', poolSlots.size === 1, [...poolSlots])
  const owner = [...poolSlots.values()][0]
  check('DatabasePool slot owned by the app Env', owner === app.app.id, { owner, appEnv: app.app.id, infraEnv: app.infrastructure.id })
  const shared = [DatabasePool.key, PipelineBuilder.key, Renderer.key, ...STAGE_FACTORIES.map(factory => factory.key), 'hyla.mini/postgres-content-store@0.1.0']
  const allowedOwned = {
    siteAlpha: [SiteContext.key, SessionAuth.key],
    siteBeta: [SiteContext.key, SignedTokenAuth.key],
    request: [RequestHandler.key],
    build: [StaticBuilder.key],
  }
  for (const [name, inspection] of Object.entries(inspections)) {
    if (!allowedOwned[name]) continue
    const owned = inspection.nodes.filter(node => node.kind === 'service' && node.ownerEnvId === inspection.id).map(node => node.label)
    check(`${name} Env owns only ${JSON.stringify(allowedOwned[name])}`, owned.length > 0 && owned.every(label => allowedOwned[name].includes(label)), owned)
    const sharedOwnedHere = inspection.nodes.filter(node => node.ownerEnvId === inspection.id && shared.includes(node.label)).map(node => node.label)
    check(`${name} Env owns no shared infrastructure slot`, sharedOwnedHere.length === 0, sharedOwnedHere)
  }

  const buildExplanation = await beta.env.explain(BuildEntry, { build: { outputDir: buildDir } })
  check('BuildEntry: no forked services, exactly one new (StaticBuilder)', buildExplanation.ok && buildExplanation.services.forked === 0 && buildExplanation.services.new === 1, buildExplanation.ok ? buildExplanation.forks.map(fork => fork.nodeId) : buildExplanation.error)
  const requestExplanation = await alpha.env.explain(RequestEntry, { request: PROBE_REQUEST })
  const poolNode = requestExplanation.ok ? requestExplanation.nodes.find(node => node.nodeId === `service:${DatabasePool.key}`) : undefined
  check('RequestEntry inherits DatabasePool and PostgresContentStore', requestExplanation.ok && poolNode?.disposition === 'inherited' && requestExplanation.nodes.find(node => node.nodeId === 'service:hyla.mini/postgres-content-store@0.1.0')?.disposition === 'inherited', poolNode)

  // Reach the pool instance through an Entry that requires it: it must be the inherited app slot.
  const PoolProbe = define.entry('audit-pool-probe', { requires: { pool: DatabasePool } })
  const probeExplanation = await app.app.explain(PoolProbe)
  check('a child Entry requiring DatabasePool inherits it (no new/forked service)', probeExplanation.ok && probeExplanation.services.new === 0 && probeExplanation.services.forked === 0, probeExplanation.ok ? probeExplanation.services : probeExplanation.error)
  const poolEnv = await app.app.enter(PoolProbe)
  const pool = await poolEnv.deps.pool.load()
  const pids = await pool.withTransaction(async client => {
    const first = (await client.query('select pg_backend_pid() as pid')).rows[0].pid
    const second = (await client.query('select pg_backend_pid() as pid')).rows[0].pid
    return [first, second]
  })
  check('a transaction runs on one leased client', pids[0] === pids[1], pids)
  const searchPath = (await pool.query('show search_path')).rows[0].search_path
  check('pool pinned to the app schema', searchPath === harness.schema, { searchPath, schema: harness.schema })
  const statsBefore = pool.stats()
  await poolEnv.dispose()
  await buildEnv.dispose()
  await requestEnv.dispose()
  alpha.release()
  beta.release()
  check('disposing probe/request/build Envs and releasing site leases does not end the pool', ended === 0, { ended, statsBefore, statsAfter: pool.stats() })
  const stillWorks = await settled(pool.query('select 1 as ok'))
  check('pool still usable after child Envs are gone', stillWorks.ok && stillWorks.value.rows[0].ok === 1)

  await app.close()
  check('pool ended exactly once on app.close()', ended === 1, { ended })
  const afterClose = await settled(pool.query('select 1'))
  check('queries reject after close', !afterClose.ok, afterClose.ok ? 'resolved' : afterClose.error.message)
  await app.runtime.dispose()
  check('second runtime.dispose() is a no-op for the pool', ended === 1, { ended })
  check('no live Envs after dispose', app.runtime.inspect().liveEnvCount === 0, app.runtime.inspect().liveEnvCount)
  check('still exactly one pool ever created', created === 1, { created })
}
finally {
  await harness.close() // third dispose + schema drop
  check('harness.close() (third dispose) still leaves end count at 1', ended === 1, { ended })
  await rm(buildDir, { recursive: true, force: true })
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

// p10 — Both backends: a public-repository mutation of tenant T issued while a transaction(T) unit
// of work that already mutated something is still open (here: from inside the work itself) hangs
// forever, and so does the unit of work waiting for it.
//
// Filesystem: transaction() holds the tenant's KeyedMutex for the whole work; the public call waits
// for that same lock — no error, no timeout.
// PostgreSQL: the unit of work holds the row lock on the tenant's content_versions row from its first
// bump to COMMIT; the nested public mutation (its own transaction on a second pooled connection) blocks
// on that row in its bump; the server cannot see the cycle (the outer session is idle in transaction,
// not waiting on a lock), so no 40P01 ever arrives. The same happens to any concurrent public write of
// tenant T while a transaction(T) is open: it waits for the whole unit of work, unboundedly.
// Second order: runtime.dispose() → pool.end() waits for every leased client and therefore never
// returns while such a unit of work is stuck (no timeout in DatabasePool's onDispose).
//
// The probe exits explicitly and leaves the PostgreSQL schema to the temporary cluster's removal
// (its rows are locked by the stuck sessions; a DROP SCHEMA would block too).
// Run (filesystem only): node <this file>
// Run (with PostgreSQL): SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime } from '@syna/core'
import {
  BlogLayout, ContentLayoutChoice, ContentRoot, DatabaseConfig, DatabasePool, DefaultLayout,
  FilesystemContentStore, PostgresContentStore, define,
} from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function probe(label, store, pool) {
  const tenant = `re-${store.backend}`
  const outcome = await Promise.race([
    store.transaction(tenant, async repository => {
      await repository.saveCategory({ slug: 'inside', name: 'Inside' })
      await store.forTenant(tenant).saveTag({ slug: 'public-inside', name: 'Public inside' }) // the public repository of the same tenant
      return 'returned'
    }).then(value => value, error => `rejected: ${error.message}`),
    sleep(3000).then(() => 'still pending after 3 s'),
  ])
  const activity = pool
    ? (await pool.query("select state, wait_event_type, left(query, 60) as query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' order by backend_start")).rows
    : undefined
  console.log(`${label}: ${outcome}${pool ? `; pool ${JSON.stringify(pool.stats())}; sessions ${JSON.stringify(activity)}` : ''}`)
  check(`${label}: a public-repository mutation of the same tenant issued inside transaction() settles (result or error)`, outcome !== 'still pending after 3 s', outcome)
  // A plain concurrent public write of the tenant while the unit of work is open is blocked as well.
  const concurrent = await Promise.race([
    store.forTenant(tenant).saveTag({ slug: 'concurrent', name: 'Concurrent' }).then(() => 'saved', error => `rejected: ${error.message}`),
    sleep(2000).then(() => 'still pending after 2 s'),
  ])
  check(`${label}: a concurrent public write of the tenant completes while the unit of work is open`, concurrent === 'saved', concurrent)
}

const FsEntry = define.entry('audit3-p10-filesystem', { requires: { store: FilesystemContentStore }, parameters: { root: ContentRoot, layout: ContentLayoutChoice } })
const PgEntry = define.entry('audit3-p10-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [FilesystemContentStore, DefaultLayout, BlogLayout, DatabasePool, PostgresContentStore] })
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit3-p10-'))
const connectionString = process.env.SYNA_TEST_PG_URL
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const fsEnv = await runtime.enter(FsEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(DefaultLayout) })
await probe('filesystem', await fsEnv.deps.store.load())
if (connectionString) {
  const pgEnv = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 4 } })
  await probe('postgres', await pgEnv.deps.store.load(), await pgEnv.deps.pool.load())
}
else console.log('postgres part skipped: SYNA_TEST_PG_URL not set')

const disposed = await Promise.race([runtime.dispose().then(() => 'disposed'), sleep(3000).then(() => 'dispose still pending after 3 s')])
check('runtime.dispose() completes while a unit of work is stuck (pool.end() waits for every leased client)', disposed === 'disposed', disposed)
await rm(rootDir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

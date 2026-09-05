// p4 — PostgreSQL: two concurrent transaction() units of work on one tenant can deadlock.
//
// Every mutation bumps the tenant's single content_versions row inside the same transaction, so a
// unit of work holds that row lock from its first mutation to COMMIT. Two units that touch the
// same posts in a different order then wait for each other (T1: post a, version row, post b;
// T2: post b, version row → waits for T1; T1: post b → waits for T2). PostgreSQL resolves it after
// deadlock_timeout (1 s) by aborting one with 40P01 — a raw DatabaseError, not a domain error, and
// nothing retries. The public path (one mutation per transaction, locks always taken in the order
// entity row → version row) cannot deadlock: control below.
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import { DatabaseConfig, DatabasePool, PostgresContentStore, define } from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const draft = (id, extra = {}) => ({ id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'draft', categories: [], tags: [], ...extra })

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p4: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PgEntry = define.entry('audit3-p4-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
try {
  const env = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 6 } })
  const store = await env.deps.store.load()
  const pool = await env.deps.pool.load()
  const repository = store.forTenant('dl')
  await repository.savePost(draft('a'))
  await repository.savePost(draft('b'))

  const started = Date.now()
  const t1 = store.transaction('dl', async tx => { await tx.savePost(draft('a', { body: 't1\n' })); await sleep(300); await tx.savePost(draft('b', { body: 't1\n' })); return 't1' })
  const t2 = store.transaction('dl', async tx => { await tx.savePost(draft('b', { body: 't2\n' })); await sleep(300); await tx.savePost(draft('a', { body: 't2\n' })); return 't2' })
  const results = await Promise.allSettled([t1, t2])
  const summary = results.map(result => result.status === 'fulfilled' ? result.value : `${result.reason.name} ${result.reason.code ?? ''}: ${result.reason.message}`)
  console.log(`postgres: two units of work on one tenant, opposite post order, took ${Date.now() - started} ms → ${JSON.stringify(summary)}`)
  check('postgres: two concurrent transaction() units of work on one tenant both complete', results.every(result => result.status === 'fulfilled'), summary)
  check('postgres: no unit of work failed with a deadlock (40P01)', !results.some(result => result.status === 'rejected' && result.reason.code === '40P01'), summary)
  check('postgres: the pool destroyed no connection over it', pool.stats().removed === 0, pool.stats())

  // Control: 20 concurrent public-path saves of the same two posts never deadlock.
  const publicSaves = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => repository.savePost(draft(index % 2 ? 'a' : 'b', { body: `${index}\n` }))))
  check('postgres (control): 20 concurrent public-path saves of two posts all succeed', publicSaves.every(result => result.status === 'fulfilled'), publicSaves.filter(result => result.status === 'rejected').map(result => result.reason.code))
}
finally {
  await runtime.dispose()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
  finally { await client.end() }
}
process.exitCode = failed === 0 ? 0 : 1

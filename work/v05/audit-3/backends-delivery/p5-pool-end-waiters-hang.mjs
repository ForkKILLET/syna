// p5 — DatabasePool: a lease that is waiting in the queue when the pool is disposed never settles.
//
// pg-pool 3.14 `end()` drains idle clients and resolves once every leased client is released; its
// `_pulseQueue` returns early while `ending` and never serves or rejects `_pendingQueue`. A
// `withClient()` / `withTransaction()` that was queued (pool saturated) before `runtime.dispose()`
// therefore hangs forever: no result, no error, `stats().waiting` stays 1. Requests that were waiting
// for a connection when the app closes get no response and no error.
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import { DatabaseConfig, DatabasePool, define } from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p5: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PoolEntry = define.entry('audit3-p5-pool', { requires: { pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [DatabasePool] })
const env = await runtime.enter(PoolEntry, { config: { connectionString, schema, max: 1 } })
const pool = await env.deps.pool.load()

let releaseHold
const hold = new Promise(resolve => { releaseHold = resolve })
const holder = pool.withClient(async () => { await hold; return 'held' })
await sleep(100)
const waiter = pool.withClient(async () => 'served').then(value => value, error => `rejected: ${error.message}`)
await sleep(100)
check('setup: the second lease is queued behind the only connection', pool.stats().waiting === 1 && pool.stats().total === 1, pool.stats())

const disposing = runtime.dispose() // → onDispose → pool.end()
await sleep(100)
releaseHold()
check('setup: the holder finishes normally', await holder === 'held')
await disposing
const outcome = await Promise.race([waiter, sleep(2000).then(() => 'still pending after 2 s')])
console.log(`waiter outcome: ${outcome}; pool stats after dispose: ${JSON.stringify(pool.stats())}`)
check('a lease queued before dispose settles (served or rejected) once the pool has ended', outcome !== 'still pending after 2 s', { outcome, stats: pool.stats() })
check('a lease requested after dispose is rejected promptly', (await pool.withClient(async () => 'late').then(value => value, error => `rejected: ${error.message}`)).startsWith('rejected'))

const client = new pg.Client({ connectionString })
await client.connect()
try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
finally { await client.end() }
process.exitCode = failed === 0 ? 0 : 1

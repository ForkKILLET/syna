// p1 — PostgreSQL: transaction() resolves after a silent ROLLBACK.
//
// Inside store.transaction(), a statement that fails at the SQL level aborts the server-side
// transaction. The deterministic trigger used here is a NUL byte in a post body: PostgreSQL text
// columns refuse it (SQLSTATE 22021) while the filesystem backend writes it (a backend divergence
// of its own). If the work catches the error and returns — the way any caller of the repository
// API may handle a SlugConflictError, whose pre-check variant is a plain JS throw — withTransaction()
// sends COMMIT, PostgreSQL answers with the command tag ROLLBACK and no error, and transaction()
// resolves with the work's value although nothing was written (the saveCategory before the error
// and its content-version bump included).
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import {
  BlogLayout, ContentLayoutChoice, ContentRoot, DatabaseConfig, DatabasePool, DefaultLayout,
  FilesystemContentStore, PostgresContentStore, define,
} from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const draft = (id, extra = {}) => ({ id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'draft', categories: [], tags: [], ...extra })

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p1: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PgEntry = define.entry('audit3-p1-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const FsEntry = define.entry('audit3-p1-filesystem', { requires: { store: FilesystemContentStore }, parameters: { root: ContentRoot, layout: ContentLayoutChoice } })
const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore, FilesystemContentStore, DefaultLayout, BlogLayout] })
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit3-p1-'))
try {
  const pgEnv = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 4 } })
  const store = await pgEnv.deps.store.load()
  const pool = await pgEnv.deps.pool.load()
  const fsEnv = await runtime.enter(FsEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(DefaultLayout) })
  const fsStore = await fsEnv.deps.store.load()

  // Mechanism: COMMIT of an aborted transaction is not an error in PostgreSQL.
  const tag = await pool.withClient(async client => {
    await client.query('BEGIN')
    await client.query('select 1/0').catch(() => undefined)
    const commit = await client.query('COMMIT')
    return commit.command
  })
  check('mechanism: COMMIT after a failed statement answers with the ROLLBACK command tag and no error', tag === 'ROLLBACK', { tag })
  const viaPool = await pool.withTransaction(async client => {
    await client.query('create temporary table audit3_p1 (n int)')
    await client.query('select 1/0').catch(() => undefined)
    return 'resolved'
  }).then(value => value, error => `rejected: ${error.message}`)
  check('DatabasePool.withTransaction() rejects when its COMMIT did not commit', viaPool !== 'resolved', { viaPool })

  for (const [label, target] of [['postgres', store], ['filesystem', fsStore]]) {
    const tenant = `tx-${label}`
    const outcome = await target.transaction(tenant, async repository => {
      await repository.saveCategory({ slug: 'kept', name: 'Kept' })
      let caught
      try { await repository.savePost(draft('nul-body', { body: 'x\0y' })) }
      catch (error) { caught = { name: error.name, code: error.code } }
      // The work handles the error and finishes normally, as a caller of the repository API may.
      return { caught, returned: 'work finished' }
    }).then(value => ({ resolved: value }), error => ({ rejected: { name: error.name, code: error.code, message: error.message } }))
    const categories = (await target.forTenant(tenant).listCategories()).map(item => item.slug)
    const version = await target.forTenant(tenant).contentVersion()
    const post = await target.forTenant(tenant).getPostById('nul-body')
    console.log(`${label}: transaction() outcome ${JSON.stringify(outcome)}; categories afterwards ${JSON.stringify(categories)}; contentVersion ${version}; post nul-body ${post ? 'present' : 'absent'}`)
    if (label === 'postgres') {
      check('postgres: a NUL byte in a post body is refused at the SQL level (22021) — the filesystem backend accepts it (divergence)', outcome.resolved?.caught?.code === '22021', outcome.resolved?.caught ?? outcome)
      check('postgres: a transaction() that resolves has committed its unit of work (the saveCategory before the caught error, and its version bump)', !('resolved' in outcome) || (categories.includes('kept') && version !== '0'), { outcome, categories, version })
    }
    else {
      check('filesystem (control): the same work keeps the category and the NUL-byte post', categories.includes('kept') && post !== undefined, { categories, body: post?.body })
    }
  }

  // Secondary divergence: listTenants() on PostgreSQL is `sites ∪ posts`; a tenant that only has categories or tags is invisible there.
  await store.forTenant('only-category').saveCategory({ slug: 'c', name: 'C' })
  await fsStore.forTenant('only-category').saveCategory({ slug: 'c', name: 'C' })
  const pgTenants = await store.listTenants()
  const fsTenants = await fsStore.listTenants()
  check('listTenants(): a tenant that only has a category is listed by both backends', pgTenants.includes('only-category') && fsTenants.includes('only-category'), { postgres: pgTenants.includes('only-category'), filesystem: fsTenants.includes('only-category') })
}
finally {
  await runtime.dispose()
  await rm(rootDir, { recursive: true, force: true })
  const client = new pg.Client({ connectionString })
  await client.connect()
  try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
  finally { await client.end() }
}
process.exitCode = failed === 0 ? 0 : 1

// p9 — Filesystem: the repository handed to transaction() serializes nothing among its own calls.
//
// The public repository wraps every mutation in the tenant lock; the transaction() repository is
// built with `serialize = fn => fn()` (store.ts) because the tenant lock is already held around the
// work. Mutations the work issues concurrently (Promise.all) therefore interleave their
// read-modify-write of categories.json / tags.json and their version bumps: categories are lost
// and the version advances by less than the number of mutations. PostgreSQL control: the leased
// client queues the statements, all ten categories land.
//
// Run (filesystem only): node <this file>
// Run (with the PostgreSQL control): SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
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
const count = 10

async function probe(label, store) {
  const tenant = `cc-${store.backend}`
  const before = Number(await store.forTenant(tenant).contentVersion())
  const saved = await store.transaction(tenant, repository =>
    Promise.all(Array.from({ length: count }, (_, index) => repository.saveCategory({ slug: `c-${index}`, name: `C${index}` }))))
  const listed = (await store.forTenant(tenant).listCategories()).map(item => item.slug)
  const after = Number(await store.forTenant(tenant).contentVersion())
  console.log(`${label}: transaction() returned ${saved.length} categories; listCategories afterwards has ${listed.length}; contentVersion ${before} → ${after}`)
  check(`${label}: ten concurrent saveCategory calls inside one transaction() all land`, listed.length === count, listed)
  check(`${label}: the content version advanced once per mutation`, after - before === count, { before, after })
}

const FsEntry = define.entry('audit3-p9-filesystem', { requires: { store: FilesystemContentStore }, parameters: { root: ContentRoot, layout: ContentLayoutChoice } })
const PgEntry = define.entry('audit3-p9-postgres', { requires: { store: PostgresContentStore }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [FilesystemContentStore, DefaultLayout, BlogLayout, DatabasePool, PostgresContentStore] })
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit3-p9-'))
const connectionString = process.env.SYNA_TEST_PG_URL
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
try {
  const fsEnv = await runtime.enter(FsEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(DefaultLayout) })
  await probe('filesystem', await fsEnv.deps.store.load())
  if (connectionString) {
    const pgEnv = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 4 } })
    await probe('postgres (control)', await pgEnv.deps.store.load())
  }
  else console.log('postgres control skipped: SYNA_TEST_PG_URL not set')
}
finally {
  await runtime.dispose()
  await rm(rootDir, { recursive: true, force: true })
  if (connectionString) {
    const client = new pg.Client({ connectionString })
    await client.connect()
    try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
    finally { await client.end() }
  }
}
process.exitCode = failed === 0 ? 0 : 1

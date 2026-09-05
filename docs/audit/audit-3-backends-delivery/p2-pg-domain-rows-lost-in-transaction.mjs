// p2 — PostgreSQL: a DomainConflictError raised inside transaction() has already deleted the
// tenant's own domain rows (`delete from domains where tenant_id = $1` runs before the conflict
// check); a work function that handles the error and returns commits that deletion. The tenant's
// stored configuration still lists its domains, the domains table no longer protects them, and
// another tenant's claim is accepted. Two stored configurations then claim one host, which the
// domain table serves to nobody (D46). Filesystem control: the conflict is detected before any
// write, so nothing is lost there.
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import {
  BlogLayout, ContentLayoutChoice, ContentRoot, DatabaseConfig, DatabasePool, DefaultLayout, DomainConflictError,
  FilesystemContentStore, PostgresContentStore, SessionAuth, SiteAuth, define, defaultRecipes, loadContentFixture,
  loadDomainTable, siteConfigInputFromFixture,
} from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const fixture = loadContentFixture()
const extras = { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }
const config = (tenantId, domains) => ({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, extras), domains })

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p2: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PgEntry = define.entry('audit3-p2-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const FsEntry = define.entry('audit3-p2-filesystem', { requires: { store: FilesystemContentStore }, parameters: { root: ContentRoot, layout: ContentLayoutChoice } })
const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore, FilesystemContentStore, DefaultLayout, BlogLayout] })
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit3-p2-'))

async function probe(label, store, rowsFor) {
  await store.forTenant('own').saveSiteConfig(config('own', ['own.test']))
  await store.forTenant('other').saveSiteConfig(config('other', ['other.test']))
  const outcome = await store.transaction('own', async repository => {
    try { await repository.saveSiteConfig(config('own', ['own.test', 'other.test'])) }
    catch (error) {
      if (!(error instanceof DomainConflictError)) throw error
      return `handled ${error.name} (owner ${error.ownerTenantId})`
    }
    return 'unexpectedly saved'
  }).then(value => ({ resolved: value }), error => ({ rejected: error.message }))
  const stored = (await store.forTenant('own').getSiteConfig())?.domains
  const rows = rowsFor ? await rowsFor('own') : undefined
  const third = await store.forTenant('third').saveSiteConfig(config('third', ['own.test'])).then(() => 'claimed', error => `refused: ${error.name}`)
  const table = await loadDomainTable(store)
  console.log(`${label}: transaction ${JSON.stringify(outcome)}; own's stored domains ${JSON.stringify(stored)}; own's domain rows ${JSON.stringify(rows)}; third claiming own.test: ${third}; table resolves own.test → ${JSON.stringify(table.resolve('own.test'))}; conflicts ${JSON.stringify(table.conflicts)}`)
  check(`${label}: own's configuration still lists own.test after the handled conflict`, stored?.includes('own.test') === true, stored)
  if (rows !== undefined) check(`${label}: the domains table still holds own.test for tenant own`, rows.includes('own.test'), rows)
  check(`${label}: a third tenant cannot take own.test while own's configuration claims it`, third.startsWith('refused'), third)
  check(`${label}: own.test still resolves to tenant own`, table.resolve('own.test') === 'own', { resolves: table.resolve('own.test'), conflicts: table.conflicts })
}

try {
  const pgEnv = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 4 } })
  const pool = await pgEnv.deps.pool.load()
  await probe('postgres', await pgEnv.deps.store.load(), async tenant =>
    (await pool.query('select normalized_host from domains where tenant_id = $1 order by 1', [tenant])).rows.map(row => row.normalized_host))
  const fsEnv = await runtime.enter(FsEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(DefaultLayout) })
  await probe('filesystem (control)', await fsEnv.deps.store.load())
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

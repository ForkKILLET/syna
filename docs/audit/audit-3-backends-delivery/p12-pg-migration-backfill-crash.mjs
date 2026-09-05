// p12 — PostgreSQL: the domains back-fill runs on EVERY start over EVERY `sites` row
// (migrations.ts:87-94, `jsonb_array_elements_text(s.config->'domains')`). One stored configuration
// whose `domains` is not a JSON array — the raw-update scenario of R4/B5, which the store handles per
// tenant on read ("a SiteConfigError for that tenant, never a page") — makes applyMigrations() throw,
// so the PostgresContentStore fails to set up and no tenant is served at all. A missing `domains` key
// (their B5 test) is harmless (NULL → no rows); a scalar or object value is not.
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import {
  DatabaseConfig, DatabasePool, PostgresContentStore, SessionAuth, SiteAuth, applyMigrations, define, defaultRecipes,
  loadContentFixture, siteConfigInputFromFixture,
} from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const fixture = loadContentFixture()
const extras = { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }
const config = (tenantId, domains) => ({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, extras), domains })

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p12: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PgEntry = define.entry('audit3-p12-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
try {
  const env = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 4 } })
  const store = await env.deps.store.load()
  const pool = await env.deps.pool.load()
  await store.forTenant('healthy').saveSiteConfig(config('healthy', ['healthy.test']))
  await store.forTenant('broken').saveSiteConfig(config('broken', ['broken.test']))

  // Their B5 shape (no `domains` key): the tenant fails on read, everyone else is served, and the migration still runs.
  await pool.query(`update sites set config = '{"title": 1, "theme": "dark"}'::jsonb where tenant_id = 'broken'`)
  const brokenRead = await store.forTenant('broken').getSiteConfig().then(() => 'parsed', error => error.name)
  const healthyRead = await store.forTenant('healthy').getSiteConfig().then(config => config.domains, error => error.name)
  const migrationWithoutDomains = await applyMigrations(pool).then(() => 'ok', error => `${error.code}: ${error.message}`)
  console.log(`no domains key: broken reads as ${brokenRead}; healthy reads ${JSON.stringify(healthyRead)}; applyMigrations → ${migrationWithoutDomains}`)
  check('a stored configuration without a domains key fails only that tenant and the migration still runs', brokenRead === 'SiteConfigError' && Array.isArray(healthyRead) && migrationWithoutDomains === 'ok')

  // A `domains` value that is not an array (raw update by another program): the per-tenant boundary holds on read …
  await pool.query(`update sites set config = '{"title": "x", "domains": "broken.test"}'::jsonb where tenant_id = 'broken'`)
  const brokenRead2 = await store.forTenant('broken').getSiteConfig().then(() => 'parsed', error => error.name)
  const healthyRead2 = await store.forTenant('healthy').getSiteConfig().then(config => config.domains, error => error.name)
  check('… on read: that tenant is a SiteConfigError, the other tenant is served', brokenRead2 === 'SiteConfigError' && Array.isArray(healthyRead2), { brokenRead2, healthyRead2 })
  // … but the next start runs the back-fill over every row.
  const migration = await applyMigrations(pool).then(() => 'ok', error => `${error.code}: ${error.message}`)
  console.log(`domains = "broken.test" (a string): applyMigrations → ${migration}`)
  check('the startup migration tolerates one malformed stored configuration (the store would refuse that tenant on read)', migration === 'ok', migration)
  const fresh = createRuntime({ services: [DatabasePool, PostgresContentStore] })
  const startup = await fresh.enter(PgEntry, { config: { connectionString, schema, max: 2 } })
    .then(async fresh => { const ok = await fresh.deps.store.load().then(() => 'store set up', error => `store setup failed: ${error.code ?? error.name}`); await fresh.dispose(); return ok }, error => `enter failed: ${error.message.slice(0, 120)}`)
  await fresh.dispose()
  check('a new process starts the PostgreSQL store on that schema (serving every well-formed tenant)', startup === 'store set up', startup)
}
finally {
  await runtime.dispose()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
  finally { await client.end() }
}
process.exitCode = failed === 0 ? 0 : 1

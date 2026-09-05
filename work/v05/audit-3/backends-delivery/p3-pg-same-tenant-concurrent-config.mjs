// p3 — PostgreSQL: two saves of ONE tenant's configuration that overlap leave orphaned domain rows.
//
// saveSiteConfig takes advisory locks only for the hosts it claims, then `delete from domains where
// tenant_id = $1`, then inserts its claims, then upserts `sites`. Two saves of the same tenant with
// different domain sets lock different keys, both delete (nothing — the other's rows are uncommitted
// and invisible), both insert, and serialize only on the `sites` row. Afterwards the domains table
// holds the union of both sets while the stored configuration lists only the last writer's — a host
// no configuration lists stays claimed and refuses every other tenant until the tenant saves again.
// The filesystem backend serializes all mutations of a tenant on its lock and cannot do this; the
// PostgreSQL public path (one transaction per save) has no per-tenant serialization at all.
//
// Run: SYNA_PG_CLUSTER_DIR=/tmp/syna-audit3-pg node scripts/pg-test-cluster.mjs with -- node <this file>
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import {
  DatabaseConfig, DatabasePool, PostgresContentStore, SessionAuth, SiteAuth, define, defaultRecipes, loadContentFixture,
  normalizeDomain, siteConfigInputFromFixture,
} from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixture = loadContentFixture()
const extras = { recipes: defaultRecipes(), auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } } }
const config = (tenantId, domains) => ({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, extras), domains })

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) { console.log('SKIP p3: SYNA_TEST_PG_URL is not set (run through scripts/pg-test-cluster.mjs with -- …)'); process.exit(2) }
const schema = `hyla_audit3_${randomBytes(4).toString('hex')}`
const PgEntry = define.entry('audit3-p3-postgres', { requires: { store: PostgresContentStore, pool: DatabasePool }, parameters: { config: DatabaseConfig } })
const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore] })
try {
  const env = await runtime.enter(PgEntry, { config: { connectionString, schema, max: 6 } })
  const store = await env.deps.store.load()
  const pool = await env.deps.pool.load()
  const rows = async tenant => (await pool.query('select normalized_host from domains where tenant_id = $1 order by 1', [tenant])).rows.map(row => row.normalized_host)

  // Deterministic interleaving through transaction(): the first save is held open while the second runs its statements.
  await store.forTenant('same').saveSiteConfig(config('same', []))
  let signal
  const firstSaved = new Promise(resolve => { signal = resolve })
  const first = store.transaction('same', async repository => {
    await repository.saveSiteConfig(config('same', ['x.test']))
    signal()
    await sleep(700) // the second save's delete/select/insert run now; it blocks on the `sites` row until this commits
    return 'x.test'
  })
  const second = firstSaved.then(() => store.transaction('same', async repository => { await repository.saveSiteConfig(config('same', ['y.test'])); return 'y.test' }))
  const outcomes = (await Promise.allSettled([first, second])).map(result => result.status === 'fulfilled' ? result.value : `rejected: ${result.reason.message}`)
  const stored = (await store.forTenant('same').getSiteConfig()).domains.map(normalizeDomain).sort()
  const claims = await rows('same')
  console.log(`postgres: outcomes ${JSON.stringify(outcomes)}; stored configuration domains ${JSON.stringify(stored)}; domain rows of the tenant ${JSON.stringify(claims)}`)
  check('postgres: after two overlapping saves of one tenant, its domain rows equal its stored configuration', JSON.stringify(claims) === JSON.stringify(stored), { stored, claims })
  const newcomer = await store.forTenant('newcomer').saveSiteConfig(config('newcomer', ['x.test'])).then(() => 'claimed', error => `refused: ${error.message}`)
  check('postgres: a host that no stored configuration lists can be claimed by another tenant', newcomer === 'claimed', newcomer)

  // The public path (one transaction per save, no per-tenant serialization): how often does the race land in practice?
  await store.forTenant('pub').saveSiteConfig(config('pub', []))
  let orphaned = 0
  const rounds = 20
  for (let round = 0; round < rounds; round += 1) {
    await Promise.allSettled([
      store.forTenant('pub').saveSiteConfig(config('pub', [`r${round}-a.test`])),
      store.forTenant('pub').saveSiteConfig(config('pub', [`r${round}-b.test`])),
    ])
    const storedNow = (await store.forTenant('pub').getSiteConfig()).domains.map(normalizeDomain).sort()
    const rowsNow = await rows('pub')
    if (JSON.stringify(rowsNow) !== JSON.stringify(storedNow)) {
      orphaned += 1
      if (orphaned === 1) console.log(`postgres public path, first divergent round ${round}: stored configuration ${JSON.stringify(storedNow)}, domain rows ${JSON.stringify(rowsNow)}`)
    }
  }
  console.log(`postgres public path: ${orphaned}/${rounds} rounds of two concurrent saves of one tenant left its domain rows different from its stored configuration`)
}
finally {
  await runtime.dispose()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try { await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`) }
  finally { await client.end() }
}
process.exitCode = failed === 0 ? 0 : 1

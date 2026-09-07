// Shared harness: creates a multitenant-blog app on a real backend seeded from the fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  SessionAuth,
  SiteAuth,
  SignedTokenAuth,
  createHylaApp,
  defaultRecipes,
  loadContentFixture,
  seedAllTenants,
  siteConfigInputFromFixture,
} from '../../dist/index.js'

export const fixture = loadContentFixture()

/** Session tables and token secrets for the two tenants (test adapters only). */
export const AUTH = Object.freeze({
  alpha: {
    implementation: SiteAuth.to(SessionAuth),
    options: {
      sessions: {
        'alpha-member': { userId: 'ann', tenantId: 'alpha', roles: ['member'] },
        'alpha-editor': { userId: 'ed', tenantId: 'alpha', roles: ['member', 'editor'] },
        'beta-in-alpha-table': { userId: 'bob', tenantId: 'beta', roles: ['member'] },
      },
    },
  },
  beta: {
    implementation: SiteAuth.to(SignedTokenAuth),
    options: { secret: 'beta-test-secret' },
  },
})

export function requirePostgresUrl() {
  const url = process.env.SYNA_TEST_PG_URL
  assert.ok(url, 'SYNA_TEST_PG_URL is not set. Run through `node scripts/pg-test-cluster.mjs with -- <command>`; PostgreSQL tests never skip.')
  return url
}

export async function seedApp(app, authByTenant = AUTH) {
  const store = await app.app.deps.store.load()
  await seedAllTenants(store, fixture)
  for (const tenantId of Object.keys(fixture.tenants)) {
    await store.forTenant(tenantId).saveSiteConfig(siteConfigInputFromFixture(tenantId, fixture.tenants[tenantId], {
      recipes: defaultRecipes(),
      auth: authByTenant[tenantId],
    }))
  }
  return store
}

export async function createFilesystemApp(options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-fs-'))
  const app = await createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: options.layout ?? 'blog' }, ...options.app })
  if (options.seed !== false) await seedApp(app, options.auth)
  return {
    kind: 'filesystem',
    rootDir,
    app,
    async close() {
      await app.close()
      await rm(rootDir, { recursive: true, force: true })
    },
  }
}

export async function createPostgresApp(options = {}) {
  const connectionString = requirePostgresUrl()
  const schema = `hyla_app_${Math.random().toString(16).slice(2, 10)}`
  const app = await createHylaApp({ backend: { kind: 'postgres', database: { connectionString, schema, max: 8 } }, ...options.app })
  if (options.seed !== false) await seedApp(app, options.auth)
  return {
    kind: 'postgres',
    app,
    schema,
    async close() {
      await app.close()
      const client = new pg.Client({ connectionString })
      await client.connect()
      try { await client.query(`drop schema if exists "${schema}" cascade`) }
      finally { await client.end() }
    },
  }
}

import http from 'node:http'

/** Plain node:http request: unlike fetch(), it lets a test send an arbitrary Host header. */
export function fetchText(url, init = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: { get: name => response.headers[name.toLowerCase()] },
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

/** Removes volatile parts so dynamic and static outputs can be compared. */
export function normalizePage(html) {
  return html.replaceAll(/\s+/g, ' ').trim()
}

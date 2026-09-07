#!/usr/bin/env node
// multitenant-blog command line: serve | build | seed | explain | demo
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  BuildEntry,
  SessionAuth,
  SiteAuth,
  createHylaApp,
  defaultRecipes,
  loadContentFixture,
  preflightRequests,
  seedAllTenants,
  siteConfigInputFromFixture,
  startHttpServer,
  startStaticServer,
} from '../dist/index.js'

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = 'true'
    else { options[key] = next; index += 1 }
  }
  return { command, options }
}

/** Plain node:http GET; unlike fetch(), it can send an arbitrary Host header (the tenant is chosen by host). */
function request(url, host) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: host ? { host } : {},
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

function backendFrom(options) {
  if (options.backend === 'postgres' || options.database) {
    const connectionString = options.database ?? process.env.SYNA_TEST_PG_URL
    if (!connectionString) throw new Error('postgres backend needs --database <url> or SYNA_TEST_PG_URL')
    return { kind: 'postgres', database: { connectionString, schema: options.schema ?? 'hyla_mini', max: 8 } }
  }
  if (!options.root) throw new Error('filesystem backend needs --root <dir>')
  return { kind: 'filesystem', rootDir: path.resolve(options.root), layout: options.layout === 'blog' ? 'blog' : 'default' }
}

async function seed(app, options) {
  const store = await app.app.deps.store.load()
  const fixture = loadContentFixture()
  await seedAllTenants(store, fixture)
  for (const tenantId of Object.keys(fixture.tenants)) {
    const existing = await store.forTenant(tenantId).getSiteConfig()
    if (existing && options.reseed !== 'true') continue
    await store.forTenant(tenantId).saveSiteConfig(siteConfigInputFromFixture(tenantId, fixture.tenants[tenantId], {
      recipes: defaultRecipes(),
      auth: { implementation: SiteAuth.to(SessionAuth), options: { sessions: {} } },
    }))
  }
  console.log(`seeded tenants: ${Object.keys(fixture.tenants).join(', ')}`)
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'help') {
    console.log(`multitenant-blog <command> [--backend postgres|filesystem] [--database <url>] [--schema <name>] [--root <dir>] [--layout default|blog]
  seed                      write fixture content and site configurations
  serve [--port N]          preflight, seed if empty, start the HTTP server
  build --tenant <id> --out <dir>   static build of one tenant
  explain --tenant <id>     explain a request world and print the fork budget report
  demo                      three-cell demo (HTTP alpha, HTTP beta, static alpha) on a temporary filesystem root (or --backend postgres)`)
    return
  }
  const app = await createHylaApp({ backend: backendFrom(options) })
  const stop = async () => { await app.close() }
  process.on('SIGINT', () => { void stop().then(() => process.exit(0)) })
  try {
    if (command === 'seed') {
      await seed(app, options)
      return
    }
    if (command === 'serve') {
      const store = await app.app.deps.store.load()
      if ((await store.listTenants()).length === 0) await seed(app, options)
      const reports = await preflightRequests(app)
      console.log(`preflight ok: ${reports.map(report => `${report.entry}: ${report.localServices} local services, cost ${report.cost}`).join('; ')}`)
      const domains = await app.domains()
      for (const conflict of domains.conflicts) console.warn(`domain ${conflict.host} is claimed by ${conflict.tenants.join(' and ')}; it is served to nobody until the configurations are fixed`)
      const server = await startHttpServer({ app: app.app, domains, trustProxy: options['trust-proxy'] === 'true' }, Number(options.port ?? 0))
      const worker = await app.app.deps.worker.load()
      await worker.start({ intervalMs: 5_000, domains }) // sweeps idle site worlds and reloads the domain table
      console.log(`listening on ${server.url} for hosts: ${[...Object.keys(loadContentFixture().tenants)].join(', ')}`)
      await new Promise(() => undefined)
      return
    }
    if (command === 'build') {
      const manager = await app.app.deps.sites.load()
      const lease = await manager.acquire(options.tenant, 'build')
      try {
        const manifest = await lease.env.run(BuildEntry, { build: { outputDir: path.resolve(options.out) } }, async ({ builder }) => (await builder.load()).build())
        console.log(JSON.stringify(manifest, null, 2))
      }
      finally { lease.release() }
      return
    }
    if (command === 'explain') {
      const manager = await app.app.deps.sites.load()
      const lease = await manager.acquire(options.tenant, 'background')
      try {
        const { explainRequest } = await import('../dist/index.js')
        console.log(JSON.stringify(await explainRequest(lease.env), null, 2))
      }
      finally { lease.release() }
      return
    }
    if (command === 'demo') {
      // Self-asserting: every cell must answer 200 with the tenant's own site title in the
      // body, otherwise the demo fails (exit 1) instead of merely printing a status code.
      await seed(app, options)
      await preflightRequests(app)
      const fixture = loadContentFixture()
      const backend = backendFrom(options).kind === 'postgres' ? 'PG' : 'FS'
      const failures = []
      const cell = (label, response, marker) => {
        const ok = response.status === 200 && response.body.includes(marker)
        console.log(`demo: ${label}: ${response.status} ${Buffer.byteLength(response.body)} bytes${ok ? '' : ` — expected 200 with ${JSON.stringify(marker)} in the body`}`)
        if (!ok) failures.push(label)
      }
      const domains = await app.domains()
      const server = await startHttpServer({ app: app.app, domains })
      try {
        for (const tenantId of ['alpha', 'beta']) {
          const site = fixture.tenants[tenantId].site
          cell(`${backend} → HTTP ${tenantId} /posts/shared-slug`, await request(`${server.url}/posts/shared-slug`, site.domains[0]), site.title)
        }
        const out = await mkdtemp(path.join(tmpdir(), 'hyla-static-'))
        try {
          const manager = await app.app.deps.sites.load()
          const lease = await manager.acquire('alpha', 'build')
          let manifest
          try {
            manifest = await lease.env.run(BuildEntry, { build: { outputDir: out } }, async ({ builder }) => (await builder.load()).build())
          }
          finally {
            lease.release()
          }
          const staticServer = await startStaticServer(out)
          try {
            cell(`${backend} → static alpha /posts/shared-slug/ (${manifest.files.length} files)`, await request(`${staticServer.url}/posts/shared-slug/`), fixture.tenants.alpha.site.title)
          }
          finally {
            await staticServer.close()
          }
        }
        finally {
          await rm(out, { recursive: true, force: true })
        }
      }
      finally {
        await server.close()
      }
      if (failures.length > 0) throw new Error(`DEMO FAILED: ${failures.join('; ')}`)
      console.log('demo: OK')
      return
    }
    throw new Error(`Unknown command ${command}`)
  }
  finally {
    if (command !== 'serve') await stop()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})

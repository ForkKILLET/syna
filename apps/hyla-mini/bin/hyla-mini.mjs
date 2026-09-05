#!/usr/bin/env node
// Hyla-mini command line: serve | build | seed | explain | demo
import path from 'node:path'
import process from 'node:process'
import { mkdtemp } from 'node:fs/promises'
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
    console.log(`hyla-mini <command> [--backend postgres|filesystem] [--database <url>] [--schema <name>] [--root <dir>] [--layout default|blog]
  seed                      write fixture content and site configurations
  serve [--port N]          preflight, seed if empty, start the HTTP server
  build --tenant <id> --out <dir>   static build of one tenant
  explain --tenant <id>     explain a request world and print the fork budget report
  demo                      four-cell demo on a temporary filesystem root (or --backend postgres)`)
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
      await worker.start({ intervalMs: 5_000 })
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
      await seed(app, options)
      await preflightRequests(app)
      const domains = await app.domains()
      const server = await startHttpServer({ app: app.app, domains })
      const dynamic = await fetch(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
      console.log(`PG/FS → HTTP alpha /posts/shared-slug: ${dynamic.status} ${(await dynamic.text()).length} bytes`)
      const beta = await fetch(`${server.url}/posts/shared-slug`, { headers: { host: 'beta.test' } })
      console.log(`         beta  /posts/shared-slug: ${beta.status} ${(await beta.text()).length} bytes`)
      const out = await mkdtemp(path.join(tmpdir(), 'hyla-static-'))
      const manager = await app.app.deps.sites.load()
      const lease = await manager.acquire('alpha', 'build')
      const manifest = await lease.env.run(BuildEntry, { build: { outputDir: out } }, async ({ builder }) => (await builder.load()).build())
      lease.release()
      const staticServer = await startStaticServer(out)
      const served = await fetch(`${staticServer.url}/posts/shared-slug/`)
      console.log(`PG/FS → static alpha: ${manifest.files.length} files in ${out}; served /posts/shared-slug/: ${served.status}`)
      await staticServer.close()
      await server.close()
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

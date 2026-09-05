// Regressions for the independent application/permissions/resources audit
// (work/v05/audit/app-permissions/REPORT.md, findings F-AP-01 … F-AP-13).
// Every case pairs the counterexample with the legal behaviour next to it.
import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { override } from '@syna/core'
import {
  AuthOptions,
  AuthenticatorContract,
  BuildEntry,
  MarkdownStageFactoryContract,
  SessionAuth,
  SignedTokenAuth,
  SiteAuth,
  createFactory,
  createHylaApp,
  defaultRecipes,
  define,
  loadDomainTable,
  stageRef,
  startHttpServer,
  startStaticServer,
} from '../dist/index.js'
import { AUTH, createFilesystemApp, fetchText, fixture } from './helpers/app-harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await sleep(2)
  }
  return true
}
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))

/** An authenticator whose setup does asynchronous work, widening the creation window deterministically. */
const SlowAuth = define.service('audit-slow-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  async setup({ options }) {
    await sleep(Number(options.read().delayMs ?? 40))
    return { scheme: 'slow', async authenticate() { return { kind: 'anonymous' } } }
  },
})

const siteConfig = (tenantId, auth) => ({
  tenantId,
  title: `Tenant ${tenantId}`,
  domains: [`${tenantId}.test`],
  defaultLocale: 'en',
  theme: { name: 'paper', accent: '#000000' },
  navigation: [],
  recipes: defaultRecipes(),
  auth,
})

/** Sends a raw request line node's parser accepts but the WHATWG URL parser may not. */
function rawRequest(port, requestLine, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no response to ${requestLine}`)) }, 2_000)
    socket.on('connect', () => socket.write(`${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => { clearTimeout(timer); resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])) })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

test('F-AP-01 a SiteEnv rotated to draining while it is still being created is closed once nobody leases it', async () => {
  const harness = await createFilesystemApp({ app: { extraServices: [SlowAuth], siteManager: { capacity: 3, idleTtlMs: 60_000, acquireTimeoutMs: 300 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    const slow = store.forTenant('slow')
    await slow.saveSiteConfig(siteConfig('slow', { implementation: SiteAuth.to(SlowAuth), options: { delayMs: 60 } }))
    const liveBefore = harness.app.runtime.inspect().liveEnvCount

    // Configuration bump during creation.
    const first = manager.acquire('slow', 'request')
    assert.ok(await until(() => manager.records().some(record => record.tenantId === 'slow' && record.state === 'creating')))
    await slow.saveSiteConfig(await slow.getSiteConfig())
    const second = await manager.acquire('slow', 'request')
    const firstLease = await first
    // The world the first acquirer was creating was rotated away before it could be
    // leased; instead of failing, the acquirer re-read the configuration and joined
    // the current world. The revision-1 env is closed, not stranded.
    assert.equal(firstLease.configRevision, second.configRevision)
    assert.equal(firstLease.key, second.key)
    assert.equal(second.configRevision, 2)
    firstLease.release()
    second.release()
    assert.ok(await until(() => manager.records().every(record => record.state === 'active')), JSON.stringify(manager.records()))
    assert.equal(manager.records().filter(record => record.tenantId === 'slow').length, 1)
    assert.equal(manager.records().find(record => record.tenantId === 'slow').configRevision, 2)

    // invalidate() during creation.
    const third = manager.acquire('slow', 'request')
    await until(() => manager.records().some(record => record.tenantId === 'slow' && record.state === 'creating'))
    manager.invalidate('slow')
    ;(await third).release()
    assert.ok(await until(() => !manager.records().some(record => record.state === 'draining')), JSON.stringify(manager.records()))
    await manager.sweep()
    assert.ok(await until(() => harness.app.runtime.inspect().liveEnvCount <= liveBefore + 1), 'stranded envs would keep liveEnvCount high')

    // Capacity is genuinely free again: three other tenants fit.
    for (const tenant of ['t1', 't2']) {
      await store.forTenant(tenant).saveSiteConfig(siteConfig(tenant, AUTH.alpha))
      ;(await manager.acquire(tenant, 'request')).release()
    }
    assert.equal(manager.stats().draining, 0)
  }
  finally {
    await harness.close()
  }
})

test('F-AP-02 invalidate() while a lease is held: new acquires get a fresh env immediately; the old one closes when released', async () => {
  const harness = await createFilesystemApp()
  try {
    const manager = await harness.app.app.deps.sites.load()
    const held = await manager.acquire('alpha', 'request')
    manager.invalidate('alpha')
    const fresh = await manager.acquire('alpha', 'request')
    assert.notEqual(fresh.key, held.key, 'a different world even though configRevision did not change')
    assert.equal(fresh.configRevision, held.configRevision)
    assert.equal(manager.records().find(record => record.key === held.key).state, 'draining')
    assert.equal(manager.records().find(record => record.key === fresh.key).state, 'active')
    fresh.release()
    held.release()
    assert.ok(await until(() => manager.records().filter(record => record.tenantId === 'alpha').length === 1))
    assert.equal(manager.records()[0].key, fresh.key)
    // Control: without invalidate, a second acquire joins the same world.
    const again = await manager.acquire('alpha', 'request')
    assert.equal(again.key, fresh.key)
    again.release()
  }
  finally {
    await harness.close()
  }
})

test('F-AP-03 malformed request targets are answered with 400 instead of hanging the connection or escaping as rejections', async () => {
  const harness = await createFilesystemApp()
  const rejections = []
  const onRejection = reason => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  let server
  let staticServer
  const outputDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-static-'))
  try {
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains, onError: () => undefined })
    assert.equal(await rawRequest(server.port, 'GET http://[::1', 'alpha.test'), 400)
    assert.equal(await rawRequest(server.port, 'GET http://alpha.test:99999/', 'alpha.test'), 400)
    assert.equal(await rawRequest(server.port, 'GET http://%zz/', 'alpha.test'), 400)
    // Control: the server is alive and a well-formed request still works.
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })).status, 200)

    const manager = await harness.app.app.deps.sites.load()
    const lease = await manager.acquire('alpha', 'build')
    try {
      await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build())
    }
    finally {
      lease.release()
    }
    staticServer = await startStaticServer(outputDir)
    assert.equal((await fetchText(`${staticServer.url}/%zz`)).status, 400)
    assert.equal((await fetchText(`${staticServer.url}/posts/%e0%a4%a`)).status, 400)
    assert.equal((await fetchText(`${staticServer.url}/.hyla-build.json`)).status, 404, 'the build manifest is never published')
    assert.equal((await fetchText(`${staticServer.url}/posts/shared-slug/`)).status, 200)
    await sleep(10)
    assert.deepEqual(rejections, [])
  }
  finally {
    process.off('unhandledRejection', onRejection)
    await staticServer?.close()
    await server?.close()
    await rm(outputDir, { recursive: true, force: true })
    await harness.close()
  }
})

test('F-AP-04 edits and visibility changes reach cached pages without a configuration save', async () => {
  const harness = await createFilesystemApp()
  let server
  try {
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains })
    const get = pathname => fetchText(`${server.url}${pathname}`, { headers: { host: 'alpha.test' } })
    const store = await harness.app.app.deps.store.load()
    const alpha = store.forTenant('alpha')

    const before = await get('/posts/hello-world')
    assert.equal(before.status, 200)
    assert.equal((await get('/posts/hello-world')).body, before.body, 'second read is served from the page cache')
    const post = await alpha.getPostById('alpha-p1')
    await alpha.savePost({ ...post, body: `${post.body}\n\nAUDIT-EDIT-MARKER` })
    const edited = await get('/posts/hello-world')
    assert.match(edited.body, /AUDIT-EDIT-MARKER/)
    assert.match((await get('/')).body, /AUDIT-EDIT-MARKER|hello-world/)

    const shared = await alpha.getPostById('alpha-p2')
    assert.match((await get('/')).body, /shared-slug/)
    assert.match((await get('/category/notes')).body, /shared-slug/)
    await alpha.savePost({ ...shared, status: 'private' })
    assert.equal((await get('/posts/shared-slug')).status, 404)
    assert.doesNotMatch((await get('/')).body, /shared-slug/, 'the anonymous index no longer lists the withdrawn post')
    assert.doesNotMatch((await get('/category/notes')).body, /shared-slug/)
    // Members still see it: the member partition is keyed separately and freshly rendered.
    const member = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test', cookie: 'hyla_session=alpha-member' } })
    assert.match(member.body, /shared-slug/)
    // Control: the cache still works between mutations.
    const stats = (await (await harness.app.app.deps.sites.load()).acquire('alpha', 'request'))
    try {
      const hitsBefore = stats.context.cacheStats.hits
      await get('/')
      await get('/')
      assert.ok(stats.context.cacheStats.hits >= hitsBefore + 1)
    }
    finally {
      stats.release()
    }
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('F-AP-05/06 a burst of acquirers on a fast-failing tenant shares one creation attempt; HTTP clients see codes, not internals', async () => {
  const harness = await createFilesystemApp({ app: { siteManager: { creationBackoffMs: 500 } } })
  let server
  try {
    const manager = await harness.app.app.deps.sites.load()
    const store = await harness.app.app.deps.store.load()
    await store.forTenant('broken').saveSiteConfig(siteConfig('broken', { implementation: SiteAuth.to(SignedTokenAuth), options: {} }))
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => settled(manager.acquire('broken', 'request'))))
    assert.ok(outcomes.every(outcome => !outcome.ok))
    assert.equal(manager.stats().creationFailures, 1, 'exactly one creation attempt for the whole burst')
    const backoffs = outcomes.filter(outcome => outcome.error.code === 'SITE_CREATION_BACKOFF')
    const originals = outcomes.filter(outcome => outcome.error instanceof TypeError)
    assert.equal(backoffs.length + originals.length, 6)
    assert.ok(backoffs.every(outcome => outcome.error.cause instanceof TypeError))

    const seen = []
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains, onError: (error, context) => seen.push({ code: error.code, status: context.status, tenantId: context.tenantId }) })
    const response = await fetchText(`${server.url}/`, { headers: { host: 'broken.test' } })
    assert.equal(response.status, 503)
    assert.equal(response.body, 'Service unavailable (SITE_CREATION_BACKOFF)')
    assert.doesNotMatch(response.body, /secret|signed-token/)
    assert.deepEqual(seen.map(item => item.status), [503])
    assert.equal(seen[0].tenantId, 'broken')
    // Control: a healthy tenant still answers with content.
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })).status, 200)
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('F-AP-07/11 an unreachable database fails createHylaApp() with the connection error itself, and the runtime is released', async () => {
  const outcome = await settled(createHylaApp({
    backend: { kind: 'postgres', database: { connectionString: 'postgres://nobody@127.0.0.1:1/nowhere', schema: 'hyla_dead', max: 1 } },
  }))
  assert.equal(outcome.ok, false)
  const error = outcome.error
  const text = `${error.message} ${error.cause?.message ?? ''} ${error.errors?.map(item => item.message).join(' ') ?? ''}`
  assert.doesNotMatch(text, /rollback|Called end on pool more than once/, 'the pool is ended exactly once')
  assert.match(text, /ECONNREFUSED|connect/)
})

test('F-AP-08 the static builder never deletes files it did not write, and refuses a foreign non-empty directory', async () => {
  const harness = await createFilesystemApp()
  const outputDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-build-'))
  try {
    const manager = await harness.app.app.deps.sites.load()
    const build = async () => {
      const lease = await manager.acquire('alpha', 'build')
      try {
        return await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build())
      }
      finally {
        lease.release()
      }
    }
    // A directory with foreign content and no build manifest is refused untouched.
    await writeFile(path.join(outputDir, 'keep.md'), 'mine\n')
    await mkdir(path.join(outputDir, 'category'))
    await writeFile(path.join(outputDir, 'category', 'unrelated.txt'), 'also mine\n')
    await assert.rejects(build(), /not empty and holds no previous Hyla build/)
    assert.equal(await readFile(path.join(outputDir, 'keep.md'), 'utf8'), 'mine\n')
    assert.equal(await readFile(path.join(outputDir, 'category', 'unrelated.txt'), 'utf8'), 'also mine\n')

    // An empty directory builds; foreign files added afterwards survive the next build.
    await rm(outputDir, { recursive: true, force: true })
    await mkdir(outputDir)
    const first = await build()
    await writeFile(path.join(outputDir, 'keep.md'), 'mine\n')
    await writeFile(path.join(outputDir, 'category', 'unrelated.txt'), 'also mine\n')
    await writeFile(path.join(outputDir, 'posts', 'hello-world', 'notes.txt'), 'inside a page directory\n')
    const second = await build()
    assert.deepEqual(second.files, first.files)
    assert.equal(await readFile(path.join(outputDir, 'keep.md'), 'utf8'), 'mine\n')
    assert.equal(await readFile(path.join(outputDir, 'category', 'unrelated.txt'), 'utf8'), 'also mine\n')
    assert.equal(await readFile(path.join(outputDir, 'posts', 'hello-world', 'notes.txt'), 'utf8'), 'inside a page directory\n')
    const manifest = JSON.parse(await readFile(path.join(outputDir, '.hyla-build.json'), 'utf8'))
    assert.deepEqual(manifest.files, second.files)
    // A page that disappears between builds is removed (its directory too when empty).
    const store = await harness.app.app.deps.store.load()
    const alpha = store.forTenant('alpha')
    await alpha.savePost({ ...(await alpha.getPostById('alpha-p2')), status: 'draft' })
    const third = await build()
    assert.ok(!third.files.includes(path.join('posts', 'shared-slug', 'index.html')))
    assert.ok(!(await readdir(path.join(outputDir, 'posts'))).includes('shared-slug'))
    assert.ok((await readdir(path.join(outputDir, 'posts'))).includes('hello-world'))
  }
  finally {
    await rm(outputDir, { recursive: true, force: true })
    await harness.close()
  }
})

test('F-AP-09 stop() issued while start() is in flight wins: the loop never runs and the worker world is released', async () => {
  const harness = await createFilesystemApp()
  try {
    const worker = await harness.app.app.deps.worker.load()
    const liveBefore = harness.app.runtime.inspect().liveEnvCount
    const starting = worker.start({ intervalMs: 5 })
    assert.equal(worker.state, 'starting')
    const stopping = worker.stop()
    await Promise.all([starting, stopping])
    assert.equal(worker.state, 'stopped')
    assert.equal(worker.ticks, 0)
    assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore)
    // Control: a plain start/stop cycle still runs ticks.
    await worker.start({ intervalMs: 5 })
    assert.equal(worker.state, 'running')
    await until(() => worker.ticks >= 2)
    await worker.stop()
    assert.equal(worker.state, 'stopped')
    assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore)
  }
  finally {
    await harness.close()
  }
})

// Third review round (docs/AUDIT.md, S4 / S9): worker supervision, domain table refresh.

test('S4 a tick that throws ends the loop in state `failed` with its world released; stop() reports the error and start() recovers', async () => {
  const harness = await createFilesystemApp()
  try {
    const worker = await harness.app.app.deps.worker.load()
    const manager = await harness.app.app.deps.sites.load()
    const liveBefore = harness.app.runtime.inspect().liveEnvCount
    const realSweep = manager.sweep
    manager.sweep = async () => { throw new Error('sweep exploded') }
    await worker.start({ intervalMs: 5 })
    assert.ok(await until(() => worker.state === 'failed'), `the loop ended in state failed, not ${worker.state}`)
    assert.match(String(worker.lastError), /sweep exploded/)
    assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore, 'the failed loop released its world')
    await assert.rejects(worker.stop(), /sweep exploded/)
    assert.equal(worker.state, 'stopped')
    // The next start() runs a fresh loop; the stale error is gone.
    manager.sweep = realSweep
    await worker.start({ intervalMs: 5 })
    assert.equal(worker.lastError, undefined)
    assert.ok(await until(() => worker.ticks >= 2))
    await worker.stop()
    assert.equal(worker.state, 'stopped')
    assert.equal(harness.app.runtime.inspect().liveEnvCount, liveBefore)
  }
  finally {
    await harness.close()
  }
})

test('S4 under the default unhandled-rejection policy a failing worker tick does not crash the process; close() reports it', async () => {
  const run = promisify(execFile)
  const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const harness = fileURLToPath(new URL('./helpers/app-harness.mjs', import.meta.url))
  const script = `
    import ${JSON.stringify(dist)}
    import { createFilesystemApp } from ${JSON.stringify(harness)}
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const app = await createFilesystemApp()
    const worker = await app.app.app.deps.worker.load()
    const manager = await app.app.app.deps.sites.load()
    manager.sweep = async () => { throw new Error('tick exploded') }
    await worker.start({ intervalMs: 5 })
    const deadline = Date.now() + 3_000
    while (worker.state !== 'failed' && Date.now() < deadline) await sleep(5)
    const state = worker.state
    const report = await app.app.close()
    await app.close()
    console.log(JSON.stringify({ state, errors: report.errors.map(error => error.message + ' <- ' + (error.cause?.message ?? '')) }))
  `
  const result = await run(process.execPath, ['--input-type=module', '-e', script])
    .then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  assert.equal(result.code, 0, `the process died:\n${result.stderr}`)
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(outcome.state, 'failed')
  assert.ok(outcome.errors.some(message => /^tick exploded/.test(message)), `the failure reached the owner's cleanup report through the worker's cleanup: ${JSON.stringify(outcome)}`)
})

test('S9 a tenant saved after startup is served without a restart; unknown hosts reload the domain table at most once per interval and share one reload', async () => {
  const harness = await createFilesystemApp()
  let server
  try {
    const store = await harness.app.app.deps.store.load()
    const domains = await harness.app.domains()
    assert.equal(domains.refreshes, 1)
    server = await startHttpServer({ app: harness.app.app, domains, domainRefreshMinIntervalMs: 300, onError: () => undefined })
    await sleep(320) // the initial load counts as a reload: nothing reloads inside its interval
    // Two unknown hosts inside one interval cost one reload.
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'nobody.test' } })).status, 404)
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'nobody-else.test' } })).status, 404)
    assert.equal(domains.refreshes, 2)
    // Concurrent unknown hosts share one reload.
    await sleep(320)
    const concurrent = await Promise.all(['a.nobody.test', 'b.nobody.test', 'c.nobody.test'].map(host => fetchText(`${server.url}/`, { headers: { host } })))
    assert.deepEqual(concurrent.map(response => response.status), [404, 404, 404])
    assert.equal(domains.refreshes, 3)
    // A tenant saved now is routable after the interval, through the unknown-host reload.
    await store.forTenant('delta').saveSiteConfig({ ...siteConfig('delta', AUTH.alpha), domains: ['delta.test'] })
    await sleep(320)
    const served = await fetchText(`${server.url}/`, { headers: { host: 'delta.test' } })
    assert.equal(served.status, 200, served.body)
    assert.equal(domains.resolve('delta.test'), 'delta')
    assert.equal(domains.refreshes, 4)
    // A known host never triggers a reload.
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })).status, 200)
    assert.equal(domains.refreshes, 4)
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('S9 the maintenance worker reloads the domain table on every tick; a failed reload is counted and keeps the previous table', async () => {
  const harness = await createFilesystemApp()
  try {
    const store = await harness.app.app.deps.store.load()
    const domains = await harness.app.domains()
    const worker = await harness.app.app.deps.worker.load()
    await worker.start({ intervalMs: 5, domains })
    await store.forTenant('epsilon').saveSiteConfig({ ...siteConfig('epsilon', AUTH.alpha), domains: ['epsilon.test'] })
    assert.ok(await until(() => domains.resolve('epsilon.test') === 'epsilon'), 'the worker picked up the saved tenant')
    assert.equal(worker.refreshFailures, 0)
    const realRefresh = domains.refresh
    domains.refresh = async () => { throw new Error('store unavailable') }
    assert.ok(await until(() => worker.refreshFailures >= 2))
    assert.equal(worker.state, 'running', 'a failed reload does not end the loop')
    assert.equal(domains.resolve('epsilon.test'), 'epsilon', 'the previous table stays in use')
    domains.refresh = realRefresh
    await worker.stop()
    assert.equal(worker.state, 'stopped')
  }
  finally {
    await harness.close()
  }
})

test('R3 /comments/preview goes through the untrusted policy: a stage registered after the site\'s sanitizer cannot emit script there, while the trusted body recipe runs as written', async () => {
  const EvilRehypeFactory = define.service('audit-evil-rehype-factory', {
    provides: [MarkdownStageFactoryContract],
    setup() {
      return createFactory(
        { pluginId: 'audit-evil-rehype', kind: 'rehype', optionsVersion: 1, optionsSchema: { type: 'object', additionalProperties: false, properties: {} }, repeatable: false },
        () => processor => processor.use(() => tree => {
          tree.children.push({ type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'alert(1)' }] })
        }),
      )
    },
  })
  const harness = await createFilesystemApp({ app: { extraServices: [EvilRehypeFactory] } })
  let server
  try {
    const store = await harness.app.app.deps.store.load()
    const alpha = store.forTenant('alpha')
    const current = await alpha.getSiteConfig()
    const withEvil = recipe => ({ ...recipe, stages: [...recipe.stages.slice(0, -1), { occurrence: 'evil', ref: stageRef(EvilRehypeFactory), optionsVersion: 1, options: {} }, recipe.stages.at(-1)] })
    await alpha.saveSiteConfig({ ...current, recipes: { ...current.recipes, comment: withEvil(current.recipes.comment), body: withEvil(current.recipes.body) } })
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains })
    const preview = await fetchText(`${server.url}/comments/preview?text=${encodeURIComponent('hello [x](https://ext.test/)')}`, { headers: { host: 'alpha.test' } })
    assert.equal(preview.status, 200, preview.body)
    assert.doesNotMatch(preview.body, /<script/i, 'the comment pipeline ends with the platform sanitizer')
    assert.match(preview.body, /rel="nofollow noopener ugc"/)
    const post = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
    assert.equal(post.status, 200)
    assert.match(post.body, /<script>alert\(1\)<\/script>/, 'a trusted body recipe runs as written, late stage included')
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('R4 a malformed session cookie is an anonymous request, not a 500', async () => {
  const harness = await createFilesystemApp()
  let server
  try {
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains, onError: () => undefined })
    const plain = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    const malformed = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test', cookie: 'hyla_session=%E0%A4%A; other=%ZZ' } })
    assert.equal(malformed.status, 200)
    assert.equal(malformed.body, plain.body, 'served as anonymous')
    const member = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test', cookie: 'hyla_session=alpha-member' } })
    assert.equal(member.status, 200)
    assert.notEqual(member.body, plain.body, 'control: a valid session sees more')
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('F-AP-10 an override whose instance lacks the Authenticator interface fails site creation, not the first request', async () => {
  const Broken = define.service('audit-broken-auth', { setup: () => ({ scheme: 'broken' }) })
  const harness = await createFilesystemApp({ app: { runtime: { overrides: [override(SessionAuth, Broken)] } } })
  let server
  try {
    const manager = await harness.app.app.deps.sites.load()
    await assert.rejects(manager.acquire('alpha', 'request'), error => error instanceof TypeError && /Authenticator interface/.test(error.message))
    assert.equal(manager.records().length, 0, 'no half-configured site env is kept')
    const domains = await harness.app.domains()
    server = await startHttpServer({ app: harness.app.app, domains, onError: () => undefined })
    const response = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    assert.equal(response.status, 503)
    // Control: beta uses SignedTokenAuth and is unaffected by the SessionAuth override.
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'beta.test' } })).status, 200)
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('F-AP-12 close() reports leases still held at shutdown instead of discarding the report', async () => {
  const clean = await createFilesystemApp()
  const cleanReport = await clean.app.close()
  assert.deepEqual(cleanReport, { unreleasedLeases: [], unsettledAttempts: [], errors: [] })
  await clean.close()

  const harness = await createFilesystemApp({ app: { siteManager: { shutdownTimeoutMs: 30 } } })
  try {
    const manager = await harness.app.app.deps.sites.load()
    const lease = await manager.acquire('alpha', 'request')
    const report = await harness.app.close()
    assert.equal(report.unreleasedLeases.length, 1)
    assert.match(report.unreleasedLeases[0], new RegExp(`^${lease.key.replaceAll('|', '\\|')}#1$`))
    lease.release()
  }
  finally {
    await harness.close()
  }
})

test('F-AP-13 an out-of-band domain conflict disables only that host and is reported; every other tenant keeps serving', async () => {
  const harness = await createFilesystemApp()
  let server
  try {
    // Written behind the store's back: the store itself refuses such a save (see repository conformance).
    await mkdir(path.join(harness.rootDir, 'gamma', 'posts'), { recursive: true })
    await writeFile(path.join(harness.rootDir, 'gamma', 'site.json'), `${JSON.stringify({ ...siteConfig('gamma', AUTH.alpha), domains: ['ALPHA.test', 'gamma.test'], configRevision: 1 }, null, 2)}\n`)
    const domains = await loadDomainTable(await harness.app.app.deps.store.load())
    assert.deepEqual(domains.conflicts, [{ host: 'alpha.test', tenants: ['alpha', 'gamma'] }])
    assert.equal(domains.resolve('alpha.test'), undefined, 'a conflicted host is served to nobody')
    assert.equal(domains.resolve('www.alpha.test'), 'alpha')
    assert.equal(domains.resolve('gamma.test'), 'gamma')
    assert.equal(domains.resolve('beta.test'), 'beta')
    server = await startHttpServer({ app: harness.app.app, domains })
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })).status, 404)
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'www.alpha.test' } })).status, 200)
    assert.equal((await fetchText(`${server.url}/`, { headers: { host: 'beta.test' } })).status, 200)
    // Fixing the offending configuration and refreshing restores the host.
    await rm(path.join(harness.rootDir, 'gamma'), { recursive: true, force: true })
    await domains.refresh()
    assert.deepEqual(domains.conflicts, [])
    assert.equal(domains.resolve('alpha.test'), 'alpha')
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

test('control: the fixture tenants still round-trip through the two-tenant HTTP path after the audit fixes', async () => {
  const harness = await createFilesystemApp()
  let server
  try {
    server = await startHttpServer({ app: harness.app.app, domains: await harness.app.domains() })
    for (const [tenantId, tenant] of Object.entries(fixture.tenants)) {
      const response = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: tenant.site.domains[0] } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-hyla-tenant'), tenantId)
    }
  }
  finally {
    await server?.close()
    await harness.close()
  }
})

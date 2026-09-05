// Attack 12: failed DatabasePool setup (double pool.end), malformed request targets, sanitiser, temp files, handles after close.
// Run twice: plain, and with --unhandled-rejections=strict (the second run shows whether any recorded rejection would kill a real server).
import http from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createHylaApp, startHttpServer } from '../../../apps/hyla-mini/dist/index.js'
import { seedApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const unhandled = []
// AUDIT_NO_HANDLER=1 leaves Node's default policy in place (a real server has no handler): an unhandled rejection then kills the process.
if (!process.env.AUDIT_NO_HANDLER) process.on('unhandledRejection', reason => unhandled.push(String(reason?.message ?? reason)))
function raw(port, requestPath, headers = {}, method = 'GET') {
  return new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers, setHost: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', error => resolve({ status: `client-error ${error.code ?? error.message}`, body: '' }))
    request.end()
  })
}
const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => ({ status: 'HUNG', body: '' }))])
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else out.push(full)
  }
  return out
}
const flatten = error => {
  const out = []
  const visit = item => {
    if (!item || out.includes(item)) return
    out.push(item)
    if (item.cause) visit(item.cause)
    for (const nested of item.errors ?? []) visit(nested)
    for (const nested of item.suppressed ?? []) visit(nested)
  }
  visit(error)
  return out
}

// 1. failing DatabasePool setup (no server on port 1): pool.end() must run once, and the error surface must be the real cause
let ends = 0
const originalEnd = pg.Pool.prototype.end
pg.Pool.prototype.end = function (...args) { ends += 1; return originalEnd.apply(this, args) }
const events = []
const bad = await settled(createHylaApp({
  backend: { kind: 'postgres', database: { connectionString: 'postgres://nobody@127.0.0.1:1/nope', schema: 'audit_bad' } },
  runtime: { diagnostics: { onEvent: event => events.push(event.type) } },
}))
check('1 OBSERVE: createHylaApp() with an unreachable database resolves (no connection attempted at startup; slots are lazy)', true, { resolved: bad.ok })
const load = bad.ok ? await settled(bad.value.app.deps.store.load()) : bad
check('1 the first store.load() (what app.domains() does) rejects', !load.ok)
const messages = load.ok ? [] : flatten(load.error).map(item => `${item.name}: ${item.message}`)
check('1 the real cause (ECONNREFUSED) is in the error surface', messages.some(message => /ECONNREFUSED/.test(message)), messages.slice(0, 6))
check('1 pool.end() called exactly once for the failed pool', ends === 1, { ends })
check('1 no spurious "Called end on pool more than once" cleanup error in the surface', !messages.some(message => /more than once/.test(message)), messages.filter(message => /more than once/.test(message)))
const retry = bad.ok ? await settled(bad.value.app.deps.store.load()) : bad
check('1 a second load() after the failure rejects again without a new pool.end() storm', !retry.ok && ends <= 2, { ends, message: retry.ok ? 'ok' : flatten(retry.error).at(-1)?.message })
if (bad.ok) await bad.value.close()
check('1 closing the app after a failed pool setup does not call pool.end() again', ends <= 2, { ends })
check('1 diagnostics events (observe)', true, events)
const endsBeforeSchema = ends
const badSchema = await settled(createHylaApp({ backend: { kind: 'postgres', database: { connectionString: 'postgres://nobody@127.0.0.1:1/nope', schema: 'bad-schema;drop' } } }))
const badSchemaLoad = badSchema.ok ? await settled(badSchema.value.app.deps.store.load()) : badSchema
check('1 invalid schema name rejected before any connection (TypeError, no pool created)', !badSchemaLoad.ok && ends === endsBeforeSchema && /schema must match/.test(flatten(badSchemaLoad.error).map(item => item.message).join('\n')), badSchemaLoad.ok ? 'accepted' : flatten(badSchemaLoad.error).at(-1)?.message)
if (badSchema.ok) await badSchema.value.close()

// 2. HTTP server edge cases
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-hygiene-'))
const app = await createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' } })
await seedApp(app)
const server = await startHttpServer({ app: app.app, domains: await app.domains() })
const post = await raw(server.port, '/', { host: 'alpha.test' }, 'POST')
check('2 POST → 405 with Allow', post.status === 405)
const head = await raw(server.port, '/posts/shared-slug', { host: 'alpha.test' }, 'HEAD')
check('2 HEAD → 200 empty body', head.status === 200 && head.body === '')
const xss = await raw(server.port, `/comments/preview?text=${encodeURIComponent('<img src=x onerror=alert(1)> [l](javascript:alert(1)) <script>x()</script> [ok](https://e.test)')}`, { host: 'alpha.test' })
check('2 comment preview is sanitised (no onerror/script/javascript:)', xss.status === 200 && !/onerror|<script|javascript:/.test(xss.body) && /rel="nofollow noopener ugc"/.test(xss.body), xss.body)
const bodyRaw = await raw(server.port, '/posts/shared-slug', { host: 'alpha.test' })
check('2 trusted body recipe passes raw HTML (by design; documented as trusted authors)', /<script>alert\('alpha'\)<\/script>/.test(bodyRaw.body))
const weird = [
  ['http://[::1', 'absolute-form with malformed IPv6 authority'],
  ['http://alpha.test:99999/', 'absolute-form with invalid port'],
  ['http://%zz/', 'absolute-form with malformed percent host'],
  ['/%zz', 'malformed percent-encoding in path'],
  ['*', 'asterisk-form'],
  ['alpha.test:80', 'authority-form'],
]
for (const [target, label] of weird) {
  const response = await withTimeout(raw(server.port, target, { host: 'alpha.test' }), 2000)
  check(`2 request-target ${JSON.stringify(target)} (${label}) gets a response, no hang`, response.status !== 'HUNG' && response.status !== 500, response.status)
}
await sleep(30)
check('2 no unhandled rejection from the HTTP server so far', unhandled.length === 0, unhandled)
await server.close()

// 3. temp files and handles
const tmpFiles = (await walk(rootDir)).filter(file => file.endsWith('.tmp'))
check('3 no temp files left in the content root', tmpFiles.length === 0, tmpFiles)
await app.close()
check('3 no live Envs after close', app.runtime.inspect().liveEnvCount === 0)
await sleep(20)
const resources = process.getActiveResourcesInfo().filter(item => item !== 'TTYWrap' && item !== 'Timeout')
check('3 active resources after close (observe; only the probe watchdog timer is expected)', true, process.getActiveResourcesInfo())
check('3 no sockets / servers still open after close', !resources.some(item => /TCP|Server|Pipe/.test(item)), resources)
await rm(rootDir, { recursive: true, force: true })
check('3 unhandled rejections recorded during the probe', unhandled.length === 0, unhandled)

clearTimeout(watchdog)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
process.exitCode = failed === 0 ? 0 : 1

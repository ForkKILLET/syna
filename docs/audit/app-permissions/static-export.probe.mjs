// Attack 8: static export leakage, static server traversal / malformed input, and the builder's destructive cleanup.
import http from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BuildEntry, startStaticServer } from '../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)
const unhandled = []
process.on('unhandledRejection', reason => unhandled.push(String(reason?.message ?? reason)))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function raw(port, requestPath, headers = { host: 'static' }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, headers, setHost: false }, response => {
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

const harness = await createFilesystemApp()
const outputs = { alpha: await mkdtemp(path.join(tmpdir(), 'hyla-audit-static-alpha-')), beta: await mkdtemp(path.join(tmpdir(), 'hyla-audit-static-beta-')) }
const victim = await mkdtemp(path.join(tmpdir(), 'hyla-audit-static-victim-'))
try {
  const manager = await harness.app.app.deps.sites.load()
  const manifests = {}
  for (const tenantId of ['alpha', 'beta']) {
    const lease = await manager.acquire(tenantId, 'build')
    try {
      manifests[tenantId] = await lease.env.run(BuildEntry, { build: { outputDir: outputs[tenantId] } }, async ({ builder }) => (await builder.load()).build())
    }
    finally { lease.release() }
  }
  const forbidden = [
    ['draft body', /ALPHA-DRAFT-SECRET/],
    ['alpha private body', /ALPHA-PRIVATE-SECRET/],
    ['beta private body', /BETA-PRIVATE-SECRET/],
    ['session ids', /alpha-member|alpha-editor|beta-in-alpha-table|hyla_session/],
    ['token secret', /beta-test-secret/],
    ['pg url / schema', /postgres:\/\/|hyla_app_/],
    ['absolute paths', new RegExp(`/Users/|${path.resolve(tmpdir()).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)],
    ['implementation refs / auth config', /persistent-implementation-ref|"sessions"|"secret"|implementationId/],
    ['private / draft slugs', /members-only|draft-plans|private-diary/],
    ['private / draft ids', /alpha-p3|alpha-p4|beta-p3/],
  ]
  for (const tenantId of ['alpha', 'beta']) {
    const files = await walk(outputs[tenantId])
    check(`${tenantId}: files written match manifest`, files.length === manifests[tenantId].files.length, { files: files.length, manifest: manifests[tenantId].files })
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      for (const [label, pattern] of forbidden) {
        const hit = pattern.exec(content)
        if (hit) check(`${tenantId}: ${path.relative(outputs[tenantId], file)} must not contain ${label}`, false, hit[0])
      }
    }
    check(`${tenantId}: no forbidden content in any static file (${files.length} files scanned)`, true)
    const site = JSON.parse(await readFile(path.join(outputs[tenantId], 'site.json'), 'utf8'))
    check(`${tenantId}: site.json lists published posts only`, site.posts.every(post => !['alpha-p3', 'alpha-p4', 'beta-p3'].includes(post.id)) && site.posts.length === (tenantId === 'alpha' ? 2 : 2), site.posts.map(post => post.id))
    check(`${tenantId}: site.json carries no auth/recipe configuration`, !('auth' in site) && !('recipes' in site) && !('domains' in site), Object.keys(site))
  }
  check('manifests carry the right tenant', manifests.alpha.tenantId === 'alpha' && manifests.beta.tenantId === 'beta')

  // static server: traversal and malformed input
  const server = await startStaticServer(outputs.alpha)
  const traversals = [
    '/../../../../../../../etc/passwd',
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/posts/..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    '/posts/../../site.json',
    '/..%2f..%2fetc%2fpasswd',
    '/site.json/../../../etc/hosts',
    '//etc/passwd',
    '/posts/%2e%2e%2f%2e%2e%2fsite.json',
    `/${encodeURIComponent(path.relative(outputs.alpha, outputs.beta))}/site.json`,
    '/%00',
    '/posts/shared-slug/index.html%00.txt',
  ]
  for (const requestPath of traversals) {
    const response = await withTimeout(raw(server.port, requestPath), 2000)
    const leaked = /root:|localhost|"tenantId": "beta"/.test(response.body)
    const ownFile = response.status === 200 && /"tenantId": "alpha"|Alpha Notes/.test(response.body) // WHATWG URL normalisation inside the root is not a traversal
    check(`static traversal ${JSON.stringify(requestPath)} refused (or normalised to the tenant's own file)`, !leaked && (response.status !== 200 || ownFile) && response.status !== 'HUNG', { status: response.status, ownFile })
  }
  const ok = await raw(server.port, '/posts/shared-slug/')
  check('static server serves the legit page', ok.status === 200 && /Alpha content/.test(ok.body))
  const malformed = await withTimeout(raw(server.port, '/%zz'), 2000)
  check('static server answers a malformed percent-encoding instead of hanging', malformed.status !== 'HUNG', malformed.status)
  const malformed2 = await withTimeout(raw(server.port, '/posts/%e0%a4%a'), 2000)
  check('static server answers a truncated UTF-8 percent sequence instead of hanging', malformed2.status !== 'HUNG', malformed2.status)
  const dirNoSlash = await raw(server.port, '/posts/shared-slug')
  check('directory without trailing slash served as index', dirNoSlash.status === 200 && /Alpha content/.test(dirNoSlash.body), dirNoSlash.status)
  await sleep(20)
  check('static server produced no unhandled rejection', unhandled.length === 0, unhandled)
  await server.close()

  // destructive cleanup: the builder deletes posts/, category/, index.html, site.json in ANY output dir it is given
  await mkdir(path.join(victim, 'posts', 'notes'), { recursive: true })
  await writeFile(path.join(victim, 'posts', 'notes', 'keep.md'), '---\nid: keep\n---\nunrelated content\n')
  await mkdir(path.join(victim, 'category'), { recursive: true })
  await writeFile(path.join(victim, 'category', 'unrelated.txt'), 'x')
  await writeFile(path.join(victim, 'notes.txt'), 'x')
  const lease = await manager.acquire('alpha', 'build')
  try {
    await lease.env.run(BuildEntry, { build: { outputDir: victim } }, async ({ builder }) => (await builder.load()).build())
  }
  finally { lease.release() }
  const keepExists = await stat(path.join(victim, 'posts', 'notes', 'keep.md')).then(() => true, () => false)
  const unrelatedExists = await stat(path.join(victim, 'category', 'unrelated.txt')).then(() => true, () => false)
  const notesExists = await stat(path.join(victim, 'notes.txt')).then(() => true, () => false)
  check('builder refuses to (or does not) delete pre-existing files it did not write inside posts/ and category/', keepExists && unrelatedExists, { keepExists, unrelatedExists, notesExists })
}
finally {
  await harness.close()
  for (const dir of [...Object.values(outputs), victim]) await rm(dir, { recursive: true, force: true })
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

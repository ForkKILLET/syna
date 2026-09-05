// Hypotheses that should hold (evidence for the "tested fine" list): malformed bearer tokens and cookies are
// anonymous (200), odd request targets are 400/404 never 500, the static server refuses traversal, dot-files
// and NUL bytes without a 500, Host spellings normalize, and the default comment recipe sanitizes markdown
// with raw HTML / javascript: links through /comments/preview.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BuildEntry, signToken, startHttpServer, startStaticServer } from '../../../../apps/hyla-mini/dist/index.js'
import { createFilesystemApp, fetchText } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const errors = []
const harness = await createFilesystemApp()
const outputDir = await mkdtemp(path.join(tmpdir(), 'audit3-static-'))
let server, staticServer
try {
  server = await startHttpServer({ app: harness.app.app, domains: await harness.app.domains(), onError: (error, context) => errors.push({ status: context.status, path: context.path, message: String(error?.message ?? error) }) })
  const get = (url, headers) => fetchText(`${server.url}${url}`, { headers })

  // Host spellings: case, port, trailing dot; a forwarded host is ignored without trustProxy.
  for (const host of ['alpha.test', 'ALPHA.TEST', 'alpha.test:8080', 'Alpha.Test.:443']) {
    const page = await get('/site.json', { host })
    check(`Host ${JSON.stringify(host)} resolves to alpha`, page.status === 200 && /"tenantId":"alpha"/.test(page.body), page.status)
  }
  const forwarded = await get('/site.json', { host: 'alpha.test', 'x-forwarded-host': 'beta.test' })
  check('X-Forwarded-Host is ignored without trustProxy (alpha answers)', forwarded.status === 200 && /"tenantId":"alpha"/.test(forwarded.body), forwarded.status)
  const bracket = await get('/site.json', { host: '[::1]:8080' })
  check('an IPv6 literal host is refused with 404 (not 500)', bracket.status === 404, bracket.status)

  // beta uses SignedTokenAuth: garbage bearer tokens must be anonymous, never 500.
  const tokens = ['x', '.', 'a.b', 'a.' + 'A'.repeat(100), `${Buffer.from('not json').toString('base64url')}.sig`, 'Bearer', '.'.repeat(500), `${'A'.repeat(20_000)}.${'B'.repeat(43)}`]
  for (const token of tokens) {
    const page = await get('/site.json', { host: 'beta.test', authorization: `Bearer ${token}` })
    // A 20 KB header is refused by Node itself (431); everything else must be an anonymous 200.
    check(`bearer ${JSON.stringify(token.slice(0, 24))}… is anonymous (200) or refused by the header limit (431), never 5xx`, page.status === 200 || (token.length > 16_000 && page.status === 431), page.status)
  }
  // A validly signed token, an expired one, a forged payload under a valid signature, and a token of another tenant.
  const valid = signToken('beta-test-secret', { userId: 'u', tenantId: 'beta', roles: ['member'], exp: Math.floor(Date.now() / 1000) + 60 })
  const expired = signToken('beta-test-secret', { userId: 'u', tenantId: 'beta', roles: ['member'], exp: 1 })
  const alphaIdentity = signToken('beta-test-secret', { userId: 'u', tenantId: 'alpha', roles: ['member', 'editor'], exp: Math.floor(Date.now() / 1000) + 60 })
  const forgedPayload = `${Buffer.from('[1,2,3]').toString('base64url')}.${valid.split('.')[1]}`
  for (const [name, token, expectPrivate] of [['valid member token', valid, true], ['expired token', expired, false], ['signature of another payload', forgedPayload, false], ['alpha identity signed with beta\'s secret', alphaIdentity, false]]) {
    const page = await get('/posts/private-diary', { host: 'beta.test', authorization: `Bearer ${token}` })
    check(`${name}: beta's private post is ${expectPrivate ? 'visible (200)' : 'hidden (404)'}`, page.status === (expectPrivate ? 200 : 404), page.status)
  }
  // alpha uses SessionAuth: malformed / prototype-ish cookies are anonymous.
  for (const cookie of ['hyla_session=%E0%A4%A', '__proto__=x; hyla_session=alpha-member', 'constructor=1', '=', ';;;', 'hyla_session=' + 'x'.repeat(8000)]) {
    const page = await get('/', { host: 'alpha.test', cookie })
    check(`cookie ${JSON.stringify(cookie.slice(0, 30))} answers 200`, page.status === 200, page.status)
  }

  // Request targets and paths.
  // Bad percent-encoding in the QUERY does not throw in the WHATWG parser (searchParams yields U+FFFD): 200 is right.
  for (const [url, expected] of [['/posts/%2e%2e/%2e%2e/etc/passwd', 404], ['/posts/../../site.json', 200], ['/category/../site.json', 200], ['/%00', 404], ['/posts/a%00b', 404], ['/comments/preview?text=%E0', 200], ['/site.json?%FF', 200], ['/posts/hello-world?x=%zz', 200]]) {
    const page = await get(url, { host: 'alpha.test' })
    check(`${url} → ${expected} (never 500)`, page.status === expected, page.status)
  }
  const method = await fetchText(`${server.url}/`, { method: 'POST', headers: { host: 'alpha.test' } })
  check('POST is 405 with Allow', method.status === 405 && method.headers.get('allow') === 'GET, HEAD', { status: method.status, allow: method.headers.get('allow') })

  // The default comment recipe on foreign markdown.
  const evil = '<img src=x onerror=alert(1)> [x](javascript:alert(2)) <script>alert(3)</script> <a href="https://ok.test" onclick="x()">ok</a> **b**'
  const preview = await get(`/comments/preview?text=${encodeURIComponent(evil)}`, { host: 'alpha.test' })
  check('/comments/preview strips raw HTML, javascript: links and handlers', preview.status === 200 && !/onerror|onclick|<script|javascript:/i.test(preview.body) && /<strong>b<\/strong>/.test(preview.body), preview.body)
  check('no request produced a 5xx report', errors.every(error => error.status < 500), errors)

  // Static server edge cases over a real build.
  const manager = await harness.app.app.deps.sites.load()
  const lease = await manager.acquire('alpha', 'build')
  try { await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build()) }
  finally { lease.release() }
  await writeFile(path.join(outputDir, '.secret'), 'dot\n')
  staticServer = await startStaticServer(outputDir)
  const sget = url => fetchText(`${staticServer.url}${url}`)
  for (const [url, expected] of [['/', 200], ['/index.html', 200], ['/posts/hello-world', 200], ['/posts/hello-world/', 200], ['/.hyla-build.json', 404], ['/.secret', 404], ['/posts/../.hyla-build.json', 404], ['/%2e%2e/%2e%2e/etc/passwd', 403], ['/../../etc/passwd', 403], ['/%00', 404], ['/posts/%00', 404], ['/%E0', 400], ['/site.json', 200], ['//posts/hello-world/', 404], ['/posts//hello-world/', 200]]) { // `//posts/…` parses as host "posts": 404, no leak
    const page = await sget(url)
    check(`static ${url} → ${expected}`, page.status === expected || (expected === 403 && page.status === 404), page.status)
    if (page.status === 200) check(`static ${url}: body is a build file (no manifest/lock/secret leak)`, !/hyla-build|"builder"|^dot$/m.test(page.body), page.body.slice(0, 60))
  }
}
finally {
  await staticServer?.close()
  await server?.close()
  await harness.close()
  await rm(outputDir, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1

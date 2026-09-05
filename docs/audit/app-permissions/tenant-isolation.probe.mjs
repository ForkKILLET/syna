// Attack 1 + 2: cross-tenant data over HTTP, path tricks, host handling, page-cache partitioning, config/content staleness.
import http from 'node:http'
import net from 'node:net'
import { signToken, startHttpServer } from '../../../apps/hyla-mini/dist/index.js'
import { AUTH, createFilesystemApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)

/** Raw request: the path is sent verbatim (no client-side URL normalization), Host is whatever we say (or absent). */
function raw(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers, setHost: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end()
  })
}
/** Writes an HTTP request byte-for-byte over a socket and returns the full response text. */
function rawSocket(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    const chunks = []
    socket.setTimeout(2000, () => { socket.destroy(); resolve(`TIMEOUT ${Buffer.concat(chunks).toString('utf8')}`) })
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}
const settledP = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const SECRETS = /ALPHA-DRAFT-SECRET|ALPHA-PRIVATE-SECRET|BETA-PRIVATE-SECRET/
const noSecrets = response => !SECRETS.test(response.body)

const harness = await createFilesystemApp()
const domains = await harness.app.domains()
const plain = await startHttpServer({ app: harness.app.app, domains })
const proxied = await startHttpServer({ app: harness.app.app, domains, trustProxy: true })
const store = await harness.app.app.deps.store.load()
const manager = await harness.app.app.deps.sites.load()
try {
  const alpha = (path, headers = {}) => raw(plain.port, path, { host: 'alpha.test', ...headers })
  const beta = (path, headers = {}) => raw(plain.port, path, { host: 'beta.test', ...headers })

  // --- 1. same slug, two tenants
  const a = await alpha('/posts/shared-slug')
  const b = await beta('/posts/shared-slug')
  check('shared-slug: alpha 200 with alpha content', a.status === 200 && /Alpha content for the slug/.test(a.body) && a.headers['x-hyla-tenant'] === 'alpha', a.status)
  check('shared-slug: beta 200 with beta content', b.status === 200 && /Beta/.test(b.body) && !/Alpha content/.test(b.body) && b.headers['x-hyla-tenant'] === 'beta', b.status)
  check('shared-slug: bodies differ', a.body !== b.body)

  const aCat = await alpha('/category/essays') // beta's category
  const bCat = await beta('/category/essays')
  check("alpha /category/essays lists no beta posts", aCat.status === 200 && !/beta-p/.test(aCat.body) && !/data-post-id/.test(aCat.body), { status: aCat.status })
  check("beta /category/essays lists beta posts only", bCat.status === 200 && /beta-p1/.test(bCat.body) && !/alpha-p/.test(bCat.body) && !/beta-p3/.test(bCat.body), { status: bCat.status })
  const aSite = JSON.parse((await alpha('/site.json')).body)
  const bSite = JSON.parse((await beta('/site.json')).body)
  check('/site.json is per tenant', aSite.tenantId === 'alpha' && aSite.title === 'Alpha Notes' && bSite.tenantId === 'beta' && bSite.title === 'Beta 博客', { aSite, bSite })

  // --- 1b. reaching beta's private post
  const betaSecret = AUTH.beta.options.secret
  const exp = Math.floor(Date.now() / 1000) + 60
  const forgedTenant = signToken(betaSecret, { userId: 'ann', tenantId: 'alpha', roles: ['member', 'editor'], exp })
  const realBeta = signToken(betaSecret, { userId: 'bea', tenantId: 'beta', roles: ['member'], exp })
  const attempts = {
    'from alpha domain, anonymous': await alpha('/posts/private-diary'),
    'from alpha domain, alpha-member cookie': await alpha('/posts/private-diary', { cookie: 'hyla_session=alpha-member' }),
    'from alpha domain, alpha-editor cookie': await alpha('/posts/private-diary', { cookie: 'hyla_session=alpha-editor' }),
    'from alpha domain, beta bearer token': await alpha('/posts/private-diary', { authorization: `Bearer ${realBeta}` }),
    'from beta domain, token signed with beta secret but tenantId alpha': await beta('/posts/private-diary', { authorization: `Bearer ${forgedTenant}` }),
    'from beta domain, alpha-member cookie': await beta('/posts/private-diary', { cookie: 'hyla_session=alpha-member' }),
    'from beta domain, anonymous': await beta('/posts/private-diary'),
  }
  for (const [name, response] of Object.entries(attempts)) {
    check(`beta private-diary unreachable ${name}`, response.status === 404 && noSecrets(response), response.status)
  }
  const legit = await beta('/posts/private-diary', { authorization: `Bearer ${realBeta}` })
  check('sanity: real beta member reads private-diary', legit.status === 200 && /BETA-PRIVATE-SECRET/.test(legit.body), legit.status)
  const alphaMemberOnBeta = await beta('/', { authorization: `Bearer ${forgedTenant}` })
  check('alpha identity on beta index sees only public beta posts', alphaMemberOnBeta.status === 200 && !/beta-p3/.test(alphaMemberOnBeta.body), alphaMemberOnBeta.status)

  // --- 1c. path tricks (anonymous, alpha host). None may reveal a secret; none may 500.
  const tricks = [
    '/posts/../site.json',
    '/posts/../posts/members-only',
    '/posts/%2e%2e/%2e%2e/beta/posts/private-diary',
    '/posts/private-diary%2F..%2Fmembers-only',
    '/posts/members-only%2F',
    '/posts/SHARED-SLUG',
    '/posts/Members-Only',
    '/posts/members-only/',
    '/posts//members-only',
    '/category/..',
    '/category/../posts/members-only',
    '/category/%2e%2e',
    '/category/ESSAYS',
    '//beta.test/posts/private-diary',
    'http://beta.test/posts/private-diary',
    '/posts/draft-plans?x=1',
    '/posts/members-only?hyla_session=alpha-member',
    '/site.json/../posts/members-only',
    '/%2e%2e/beta/posts/private-diary',
    '/posts/shared-slug%00',
  ]
  for (const path of tricks) {
    let response
    try { response = await alpha(path) }
    catch (error) { response = { status: `client-error ${error.code ?? error.message}`, body: '', headers: {} } }
    const ok = noSecrets(response) && response.status !== 500 && !/BETA|Beta 博客/.test(response.body)
    check(`path trick ${JSON.stringify(path)} leaks nothing`, ok, { status: response.status, tenant: response.headers['x-hyla-tenant'] })
  }

  // --- 1d. hosts
  const hostCases = [
    ['gamma.test', 404, undefined, 'unknown host'],
    ['alpha.test:8080', 200, 'alpha', 'host with port'],
    ['ALPHA.TEST', 200, 'alpha', 'upper-case host (case-insensitive by RFC)'],
    ['www.alpha.test', 200, 'alpha', 'alias domain'],
    ['[::1]:8080', 404, undefined, 'IPv6 literal'],
    ['alpha.test.', 404, undefined, 'trailing-dot host'],
    ['127.0.0.1', 404, undefined, 'bare IP'],
    ['alpha.test%00', 404, undefined, 'percent in host'],
  ]
  for (const [host, status, tenant, label] of hostCases) {
    let response
    try { response = await raw(plain.port, '/posts/shared-slug', { host }) }
    catch (error) { response = { status: `client-error ${error.code ?? error.message}`, headers: {}, body: '' } }
    check(`Host ${JSON.stringify(host)} (${label})`, response.status === status && response.headers['x-hyla-tenant'] === tenant && noSecrets(response), { status: response.status, tenant: response.headers['x-hyla-tenant'] })
  }
  const missingHost = await raw(plain.port, '/posts/shared-slug', {})
  check('missing Host header refused (400 by Node itself or 404 by the app)', (missingHost.status === 400 || missingHost.status === 404) && noSecrets(missingHost), missingHost.status)
  const missingHost10 = await rawSocket(plain.port, 'GET /site.json HTTP/1.0\r\nConnection: close\r\n\r\n')
  check('HTTP/1.0 request without Host refused by the app', /HTTP\/1\.[01] 404/.test(missingHost10) && /Unknown host \(missing\)/.test(missingHost10) && !SECRETS.test(missingHost10), missingHost10.split('\r\n')[0])
  const twoHosts = await rawSocket(plain.port, 'GET /site.json HTTP/1.1\r\nHost: alpha.test\r\nHost: beta.test\r\nConnection: close\r\n\r\n')
  check('duplicate Host headers do not reach beta', /HTTP\/1\.1 400/.test(twoHosts) || (/"tenantId":"alpha"/.test(twoHosts) && !/"tenantId":"beta"/.test(twoHosts)), twoHosts.split('\r\n')[0])
  const hostSpace = await rawSocket(plain.port, 'GET /site.json HTTP/1.1\r\nHost: alpha.test beta.test\r\nConnection: close\r\n\r\n')
  check('Host with embedded space refused', /HTTP\/1\.1 (400|404)/.test(hostSpace) && !/"tenantId"/.test(hostSpace), hostSpace.split('\r\n')[0])

  const fwdUntrusted = await raw(plain.port, '/site.json', { host: 'beta.test', 'x-forwarded-host': 'alpha.test' })
  check('X-Forwarded-Host ignored when trustProxy=false', fwdUntrusted.status === 200 && JSON.parse(fwdUntrusted.body).tenantId === 'beta', fwdUntrusted.body)
  const fwdUnknownUntrusted = await raw(plain.port, '/site.json', { host: 'gamma.test', 'x-forwarded-host': 'alpha.test' })
  check('X-Forwarded-Host cannot rescue an unknown Host when trustProxy=false', fwdUnknownUntrusted.status === 404, fwdUnknownUntrusted.status)
  const fwdTrusted = await raw(proxied.port, '/site.json', { host: 'beta.test', 'x-forwarded-host': 'alpha.test' })
  check('X-Forwarded-Host honoured when trustProxy=true', fwdTrusted.status === 200 && JSON.parse(fwdTrusted.body).tenantId === 'alpha', fwdTrusted.body)
  const fwdList = await raw(proxied.port, '/site.json', { host: 'edge.internal', 'x-forwarded-host': 'beta.test, alpha.test' })
  check('X-Forwarded-Host list: first entry wins', fwdList.status === 200 && JSON.parse(fwdList.body).tenantId === 'beta', fwdList.body)
  const fwdUnknownTrusted = await raw(proxied.port, '/site.json', { host: 'alpha.test', 'x-forwarded-host': 'gamma.test' })
  check('trusted proxy with unknown forwarded host: refused, no fallback to Host', fwdUnknownTrusted.status === 404, fwdUnknownTrusted.status)
  const fwdPort = await raw(proxied.port, '/site.json', { host: 'edge.internal', 'x-forwarded-host': 'ALPHA.test:443' })
  check('trusted forwarded host with port/case normalised', fwdPort.status === 200 && JSON.parse(fwdPort.body).tenantId === 'alpha', fwdPort.body)

  // --- 2. cache partitioning
  const anon1 = await alpha('/')
  const member = await alpha('/', { cookie: 'hyla_session=alpha-member' })
  const anon2 = await alpha('/')
  const editor = await alpha('/', { cookie: 'hyla_session=alpha-editor' })
  const member2 = await alpha('/', { cookie: 'hyla_session=alpha-member' })
  const foreign = await alpha('/', { cookie: 'hyla_session=beta-in-alpha-table' })
  const anon3 = await alpha('/')
  check('anonymous index has no private/draft', anon1.status === 200 && !/members-only|draft-plans/.test(anon1.body))
  check('member index lists members-only but not draft', /members-only/.test(member.body) && !/draft-plans/.test(member.body))
  check('editor index lists draft and members-only', /members-only/.test(editor.body) && /draft-plans/.test(editor.body))
  check('anonymous after member identical to first anonymous', anon2.body === anon1.body)
  check('member after editor identical to first member (editor render did not leak into member partition)', member2.body === member.body)
  check('foreign-tenant identity gets the anonymous partition', foreign.body === anon1.body)
  check('anonymous after editor identical to first anonymous', anon3.body === anon1.body)
  const memberPost = await alpha('/posts/members-only', { cookie: 'hyla_session=alpha-member' })
  const anonPost = await alpha('/posts/members-only')
  const editorDraft = await alpha('/posts/draft-plans', { cookie: 'hyla_session=alpha-editor' })
  const memberDraft = await alpha('/posts/draft-plans', { cookie: 'hyla_session=alpha-member' })
  const anonDraft = await alpha('/posts/draft-plans')
  check('members-only: member 200 then anonymous 404 (cached page not served)', memberPost.status === 200 && anonPost.status === 404 && noSecrets(anonPost))
  check('draft-plans: editor 200, member 404, anonymous 404', editorDraft.status === 200 && memberDraft.status === 404 && anonDraft.status === 404 && noSecrets(memberDraft) && noSecrets(anonDraft))
  check('responses are private/no-store', anon1.headers['cache-control'] === 'private, no-store', anon1.headers['cache-control'])

  // --- 2b. config revision bump between requests
  const before = await alpha('/')
  const revBefore = Number(before.headers['x-hyla-config-revision'])
  const current = await store.forTenant('alpha').getSiteConfig()
  await store.forTenant('alpha').saveSiteConfig({ ...current, title: 'Alpha Notes RENAMED' })
  const after = await alpha('/')
  const afterSite = JSON.parse((await alpha('/site.json')).body)
  check('config bump: next request enters the new revision', Number(after.headers['x-hyla-config-revision']) === revBefore + 1 && afterSite.configRevision === revBefore + 1, { revBefore, revAfter: after.headers['x-hyla-config-revision'] })
  check('config bump: old cached page is not served', /Alpha Notes RENAMED/.test(after.body) && !/Alpha Notes RENAMED/.test(before.body))
  const alphaRecords = manager.records().filter(record => record.tenantId === 'alpha')
  check('config bump: old revision record gone once idle', alphaRecords.length === 1 && alphaRecords[0].configRevision === revBefore + 1, alphaRecords)

  // --- 2c. content change WITHOUT a config bump: is the cached page stale?
  const hello1 = await alpha('/posts/hello-world')
  const index1 = await alpha('/')
  const post = await store.forTenant('alpha').getPostById('alpha-p1')
  await store.forTenant('alpha').savePost({ ...post, body: 'UPDATED-BODY-MARKER after edit\n' })
  const hello2 = await alpha('/posts/hello-world')
  const index2 = await alpha('/')
  check('post edit visible on next request without a config bump (page cache invalidated on content change)', /UPDATED-BODY-MARKER/.test(hello2.body), { stale: hello2.body === hello1.body })
  check('post edit visible in the index preview without a config bump', /UPDATED-BODY-MARKER/.test(index2.body), { stale: index2.body === index1.body })
  const memberHello = await alpha('/posts/hello-world', { cookie: 'hyla_session=alpha-member' })
  check('a not-yet-cached partition (member) sees the edited body', /UPDATED-BODY-MARKER/.test(memberHello.body))
  // status change: publish -> private without config bump: does the anonymous cache keep serving it?
  const p2 = await store.forTenant('alpha').getPostById('alpha-p2')
  await store.forTenant('alpha').savePost({ ...p2, status: 'private' })
  const sharedAfterPrivate = await alpha('/posts/shared-slug')
  check('post made private without config bump is no longer served to anonymous', sharedAfterPrivate.status === 404, { status: sharedAfterPrivate.status })
  const indexAfterPrivate = await alpha('/')
  check('anonymous index no longer lists (title + preview of) a post that was just made private', !/shared-slug/.test(indexAfterPrivate.body), { stillListed: /shared-slug/.test(indexAfterPrivate.body), stale: indexAfterPrivate.body === index2.body })
  const categoryAfterPrivate = await alpha('/category/notes')
  check('anonymous category page no longer lists a post that was just made private', !/shared-slug/.test(categoryAfterPrivate.body), { stillListed: /shared-slug/.test(categoryAfterPrivate.body) })
  await store.forTenant('alpha').savePost({ ...p2, status: 'published' })

  // --- domain table: a tenant claiming another tenant's domain
  const betaCurrent = await store.forTenant('beta').getSiteConfig()
  await store.forTenant('beta').saveSiteConfig({ ...betaCurrent, domains: [...betaCurrent.domains, 'alpha.test'] })
  const refreshed = await settledP(domains.refresh())
  const rebuilt = await settledP(harness.app.domains())
  check('domain table refresh with a conflicting claim rejects explicitly and keeps the old table', !refreshed.ok && domains.resolve('alpha.test') === 'alpha', refreshed.ok ? 'ok' : refreshed.error.message)
  check('OBSERVE: a tenant configuration claiming another tenant\'s domain makes app.domains() (and thus server start) fail for the whole deployment', true, rebuilt.ok ? 'built' : rebuilt.error.message)
  await store.forTenant('beta').saveSiteConfig({ ...betaCurrent })
}
finally {
  await plain.close()
  await proxied.close()
  await harness.close()
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

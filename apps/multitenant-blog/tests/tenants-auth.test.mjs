// H08 / H09 — two tenants, domain mapping, auth replacement, no cross-tenant or cross-principal cache leaks.
import assert from 'node:assert/strict'
import test from 'node:test'
import { signToken, startHttpServer } from '../dist/index.js'
import { AUTH, createFilesystemApp, fetchText } from './helpers/app-harness.mjs'

test('H08 domains map to tenants through the controlled table; unknown hosts and untrusted forwarded hosts are refused', async () => {
  const harness = await createFilesystemApp()
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains })
  try {
    const alpha = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'alpha.test' } })
    const www = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'www.alpha.test:8080' } })
    const beta = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'beta.test' } })
    assert.equal(alpha.status, 200)
    assert.equal(www.status, 200)
    assert.equal(www.body, alpha.body, 'a domain alias serves the same site without duplicating data')
    assert.equal(beta.status, 200)
    assert.notEqual(beta.body, alpha.body)
    assert.match(alpha.body, /Alpha content for the slug/)
    assert.match(beta.body, /租户的内容。两个租户使用了同一个 slug/)
    assert.equal(alpha.headers.get('x-hyla-tenant'), 'alpha')
    assert.equal(beta.headers.get('x-hyla-tenant'), 'beta')

    const unknown = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'gamma.test' } })
    assert.equal(unknown.status, 404)
    assert.match(unknown.body, /Unknown host/)
    const forwarded = await fetchText(`${server.url}/posts/shared-slug`, { headers: { host: 'gamma.test', 'x-forwarded-host': 'alpha.test' } })
    assert.equal(forwarded.status, 404, 'forwarded host is ignored without a trusted proxy')
    const manager = await harness.app.app.deps.sites.load()
    assert.deepEqual(manager.records().map(record => record.tenantId).sort(), ['alpha', 'beta'], 'no SiteEnv for the unknown host')
  }
  finally {
    await server.close()
    await harness.close()
  }
})

test('H08 a trusted proxy may supply the host; page caches are partitioned by tenant, locale and visibility', async () => {
  const harness = await createFilesystemApp()
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains, trustProxy: true })
  try {
    const viaProxy = await fetchText(`${server.url}/`, { headers: { host: 'edge.internal', 'x-forwarded-host': 'beta.test' } })
    assert.equal(viaProxy.status, 200)
    assert.equal(viaProxy.headers.get('x-hyla-tenant'), 'beta')

    const anonymousAlpha = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    const memberAlpha = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test', cookie: 'hyla_session=alpha-member' } })
    const anonymousAgain = await fetchText(`${server.url}/`, { headers: { host: 'alpha.test' } })
    assert.doesNotMatch(anonymousAlpha.body, /members-only/)
    assert.match(memberAlpha.body, /members-only/)
    assert.equal(anonymousAgain.body, anonymousAlpha.body, 'the member render did not leak into the anonymous cache partition')
    const manager = await harness.app.app.deps.sites.load()
    const lease = await manager.acquire('alpha', 'background')
    try {
      assert.ok(lease.context.cacheStats.hits >= 1)
      assert.ok(lease.context.cacheStats.entries >= 2, 'anonymous and member partitions are separate entries')
    }
    finally { lease.release() }
  }
  finally {
    await server.close()
    await harness.close()
  }
})

test('H09 two authenticators are swapped per site without touching content code; anonymous reads public only; A cannot read B', async () => {
  const harness = await createFilesystemApp()
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains })
  try {
    const alpha = (route, headers = {}) => fetchText(`${server.url}${route}`, { headers: { host: 'alpha.test', ...headers } })
    const beta = (route, headers = {}) => fetchText(`${server.url}${route}`, { headers: { host: 'beta.test', ...headers } })

    // alpha: session cookies
    assert.equal((await alpha('/posts/members-only')).status, 404)
    assert.equal((await alpha('/posts/members-only', { cookie: 'hyla_session=alpha-member' })).status, 200)
    assert.equal((await alpha('/posts/draft-plans', { cookie: 'hyla_session=alpha-member' })).status, 404, 'members do not see drafts')
    assert.equal((await alpha('/posts/draft-plans', { cookie: 'hyla_session=alpha-editor' })).status, 200, 'editors do')
    assert.equal((await alpha('/posts/members-only', { cookie: 'hyla_session=beta-in-alpha-table' })).status, 404, 'an identity of tenant beta gets nothing private in alpha')
    assert.equal((await alpha('/posts/members-only', { cookie: 'hyla_session=forged' })).status, 404)

    // beta: signed tokens
    const betaToken = signToken(AUTH.beta.options.secret, { userId: 'bea', tenantId: 'beta', roles: ['member'], exp: Math.floor(Date.now() / 1000) + 60 })
    const alphaToken = signToken(AUTH.beta.options.secret, { userId: 'ann', tenantId: 'alpha', roles: ['member'], exp: Math.floor(Date.now() / 1000) + 60 })
    const expired = signToken(AUTH.beta.options.secret, { userId: 'bea', tenantId: 'beta', roles: ['member'], exp: Math.floor(Date.now() / 1000) - 60 })
    const forged = signToken('wrong-secret', { userId: 'bea', tenantId: 'beta', roles: ['member'], exp: Math.floor(Date.now() / 1000) + 60 })
    assert.equal((await beta('/posts/private-diary')).status, 404)
    assert.equal((await beta('/posts/private-diary', { authorization: `Bearer ${betaToken}` })).status, 200)
    assert.equal((await beta('/posts/private-diary', { authorization: `Bearer ${alphaToken}` })).status, 404, 'a valid alpha identity cannot read beta private content')
    assert.equal((await beta('/posts/private-diary', { authorization: `Bearer ${expired}` })).status, 404)
    assert.equal((await beta('/posts/private-diary', { authorization: `Bearer ${forged}` })).status, 404)
    // Cookies mean nothing to the token authenticator and vice versa.
    assert.equal((await beta('/posts/private-diary', { cookie: 'hyla_session=alpha-member' })).status, 404)
    assert.equal((await alpha('/posts/members-only', { authorization: `Bearer ${betaToken}` })).status, 404)

    const manager = await harness.app.app.deps.sites.load()
    const [alphaLease, betaLease] = await Promise.all([manager.acquire('alpha', 'background'), manager.acquire('beta', 'background')])
    try {
      assert.equal((await alphaLease.env.deps.auth.load()).scheme, 'session-cookie')
      assert.equal((await betaLease.env.deps.auth.load()).scheme, 'signed-token')
    }
    finally {
      alphaLease.release()
      betaLease.release()
    }
  }
  finally {
    await server.close()
    await harness.close()
  }
})

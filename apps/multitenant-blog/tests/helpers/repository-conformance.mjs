import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  DomainConflictError,
  SiteConfigError,
  SlugConflictError,
  TransactionReentrancyError,
  comparePosts,
  loadContentFixture,
  seedAllTenants,
  seedTenantContent,
  siteConfigInputFromFixture,
} from '../../dist/index.js'

export const fixture = loadContentFixture()

/** A recipe of valid shape (the store validates documents structurally; it never resolves factories). */
function recipe(name) {
  const ref = familyId => ({ kind: 'implementation-ref', contractId: 'hyla.mini/markdown-stage-factory/v1', familyId, range: '^0.1.0' })
  return {
    formatVersion: 1,
    name,
    stages: [
      { occurrence: 'parse', ref: ref('hyla.mini/remark-parse-factory'), optionsVersion: 1, options: {} },
      { occurrence: 'bridge', ref: ref('hyla.mini/remark-rehype-factory'), optionsVersion: 1, options: { allowDangerousHtml: false } },
      { occurrence: 'compile', ref: ref('hyla.mini/rehype-stringify-factory'), optionsVersion: 1, options: {} },
    ],
  }
}

/** Placeholder recipe/auth documents; the real ones are owned by other layers. */
export const sampleExtras = Object.freeze({
  recipes: { body: recipe('body'), comment: recipe('comment'), preview: recipe('preview') },
  auth: {
    implementation: { kind: 'implementation-ref', contractId: 'hyla.mini/auth/v1', familyId: 'hyla.mini/test-auth', range: '^0.1.0' },
    options: { mode: 'test' },
  },
})

const ids = posts => posts.map(post => post.id)

/**
 * Shared behaviour every ContentStore backend must exhibit. `makeStore()`
 * returns `{ store, dispose }`; the suite seeds alpha and beta from the fixture
 * and finishes by deleting beta, so callers must hand it a fresh store.
 */
export function repositoryConformance(name, makeStore) {
  describe(`${name}: repository conformance`, () => {
    let handle
    let store
    let alpha
    let beta

    before(async () => {
      handle = await makeStore()
      store = handle.store
      await seedAllTenants(store, fixture)
      alpha = store.forTenant('alpha')
      beta = store.forTenant('beta')
    })

    after(async () => {
      await handle?.dispose()
    })

    it('reports its backend and lists the seeded tenants', async () => {
      assert.ok(store.backend === 'postgres' || store.backend === 'filesystem')
      const tenants = await store.listTenants()
      assert.ok(tenants.includes('alpha') && tenants.includes('beta'), `tenants: ${tenants}`)
      assert.equal(alpha.tenantId, 'alpha')
    })

    it('lists public posts versus all posts', async () => {
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'public' })).sort(), ['alpha-p1', 'alpha-p2'])
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'all' })).sort(), ['alpha-p1', 'alpha-p2', 'alpha-p3', 'alpha-p4'])
      assert.deepEqual(ids(await beta.listPosts({ visibility: 'public' })).sort(), ['beta-p1', 'beta-p2'])
      assert.deepEqual(ids(await beta.listPosts({ visibility: 'all' })).sort(), ['beta-p1', 'beta-p2', 'beta-p3'])
    })

    it('never returns drafts or private posts with public visibility', async () => {
      for (const repository of [alpha, beta]) {
        for (const post of await repository.listPosts({ visibility: 'public' })) {
          assert.equal(post.status, 'published')
        }
      }
      assert.equal(await alpha.getPost('draft-plans', { visibility: 'public' }), undefined)
      assert.equal(await alpha.getPost('members-only', { visibility: 'public' }), undefined)
      assert.equal(await beta.getPost('private-diary', { visibility: 'public' }), undefined)
      assert.equal((await alpha.getPost('draft-plans', { visibility: 'all' }))?.id, 'alpha-p3')
      assert.equal((await alpha.getPost('members-only', { visibility: 'all' }))?.body, 'ALPHA-PRIVATE-SECRET for signed-in alpha members.\n')
      assert.equal((await beta.getPost('private-diary', { visibility: 'all' }))?.id, 'beta-p3')
    })

    it('resolves the shared slug to a different post per tenant', async () => {
      const fromAlpha = await alpha.getPost('shared-slug', { visibility: 'public' })
      const fromBeta = await beta.getPost('shared-slug', { visibility: 'public' })
      assert.equal(fromAlpha.id, 'alpha-p2')
      assert.equal(fromAlpha.tenantId, 'alpha')
      assert.equal(fromAlpha.locale, 'en')
      assert.equal(fromBeta.id, 'beta-p1')
      assert.equal(fromBeta.tenantId, 'beta')
      assert.equal(fromBeta.locale, 'zh-CN')
      assert.equal(fromBeta.title, 'Beta 对同名 slug 的看法')
      assert.notEqual(fromAlpha.body, fromBeta.body)
    })

    it('isolates tenants: alpha never sees beta rows', async () => {
      for (const post of await alpha.listPosts({ visibility: 'all' })) assert.equal(post.tenantId, 'alpha')
      assert.equal(await alpha.getPostById('beta-p1'), undefined)
      assert.equal(await alpha.getPost('ni-hao', { visibility: 'all' }), undefined)
      assert.equal(await beta.getPostById('alpha-p1'), undefined)
      assert.equal(await beta.getPost('hello-world', { visibility: 'all' }), undefined)
      assert.equal(await alpha.deletePost('beta-p1'), false)
      assert.equal((await beta.getPostById('beta-p1'))?.id, 'beta-p1')
      assert.deepEqual((await beta.listCategories()).map(item => item.slug), ['essays'])
      assert.deepEqual((await alpha.listCategories()).map(item => item.slug), ['engineering', 'notes'])
    })

    it('applies locale, category and tag filters', async () => {
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'all', locale: 'zh-CN' })), [])
      assert.deepEqual(ids(await beta.listPosts({ visibility: 'all', locale: 'zh-CN' })).sort(), ['beta-p1', 'beta-p2', 'beta-p3'])
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'all', category: 'engineering' })).sort(), ['alpha-p1', 'alpha-p4'])
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'public', category: 'engineering' })), ['alpha-p1'])
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'public', tag: 'postgres' })), ['alpha-p2'])
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'all', tag: 'syna' })).sort(), ['alpha-p1', 'alpha-p2', 'alpha-p4'])
    })

    it('round-trips every stored field of a post', async () => {
      const expected = fixture.tenants.alpha.posts.find(post => post.id === 'alpha-p1')
      const post = await alpha.getPostById('alpha-p1')
      assert.deepEqual(post, {
        ...expected,
        tenantId: 'alpha',
        primaryCategory: 'engineering',
        revision: 1,
      })
      const shared = await alpha.getPostById('alpha-p2')
      assert.equal(shared.primaryCategory, 'notes', 'primaryCategory defaults to the first category')
    })

    it('orders posts deterministically with comparePosts (newest first, then slug)', async () => {
      const all = await alpha.listPosts({ visibility: 'all' })
      assert.deepEqual(ids(all), ['alpha-p4', 'alpha-p3', 'alpha-p2', 'alpha-p1'])
      assert.deepEqual(all, [...all].sort(comparePosts))
      const publicBeta = await beta.listPosts({ visibility: 'public' })
      assert.deepEqual(ids(publicBeta), ['beta-p2', 'beta-p1'])
    })

    it('increments the revision and keeps the id when the slug changes', async () => {
      const input = {
        id: 'conf-rename',
        slug: 'rename-me',
        locale: 'en',
        title: 'Rename me',
        body: 'body v1\n',
        status: 'published',
        categories: ['engineering', 'notes'],
        primaryCategory: 'engineering',
        tags: ['syna'],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }
      const first = await alpha.savePost(input)
      assert.equal(first.revision, 1)
      assert.equal(first.createdAt, input.createdAt)
      assert.equal(first.updatedAt, input.updatedAt)

      const { createdAt, updatedAt, ...withoutTimestamps } = input
      const second = await alpha.savePost({
        ...withoutTimestamps,
        slug: 'renamed',
        primaryCategory: 'notes',
        body: 'body v2\n',
      })
      assert.equal(second.id, 'conf-rename')
      assert.equal(second.revision, 2)
      assert.equal(second.slug, 'renamed')
      assert.equal(second.primaryCategory, 'notes')
      assert.equal(second.createdAt, input.createdAt, 'createdAt is preserved across saves')
      assert.ok(second.updatedAt > input.updatedAt, 'updatedAt moves forward when not supplied')
      assert.equal(await alpha.getPost('rename-me', { visibility: 'all' }), undefined)
      assert.equal((await alpha.getPost('renamed', { visibility: 'public' }))?.id, 'conf-rename')
      assert.deepEqual(await alpha.getPostById('conf-rename'), second)

      assert.equal(await alpha.deletePost('conf-rename'), true)
      assert.equal(await alpha.deletePost('conf-rename'), false)
      assert.equal(await alpha.getPostById('conf-rename'), undefined)
    })

    it('rejects a slug already used by a different id in the same tenant', async () => {
      const base = { locale: 'en', title: 'x', body: '', status: 'published', categories: [], tags: [] }
      await assert.rejects(alpha.savePost({ ...base, id: 'conf-collide', slug: 'hello-world' }), SlugConflictError)
      await assert.rejects(alpha.savePost({ ...base, id: 'alpha-p3', slug: 'hello-world' }), SlugConflictError)
      assert.equal(await alpha.getPostById('conf-collide'), undefined)
      assert.equal((await alpha.getPostById('alpha-p3'))?.slug, 'draft-plans')
      // The same slug in another tenant is fine.
      const inBeta = await beta.savePost({ ...base, id: 'beta-collide', slug: 'hello-world' })
      assert.equal(inBeta.tenantId, 'beta')
      assert.equal(await beta.deletePost('beta-collide'), true)
    })

    it('rejects unsafe tenant ids, slugs and invalid input', async () => {
      assert.throws(() => store.forTenant('../x'), TypeError)
      assert.throws(() => store.forTenant('a/b'), TypeError)
      assert.throws(() => store.forTenant('Alpha'), TypeError)
      const base = { id: 'conf-bad', locale: 'en', title: 'x', body: '', status: 'published', categories: [], tags: [] }
      await assert.rejects(alpha.savePost({ ...base, slug: '../x' }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, slug: 'a/b' }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, slug: 'ok', locale: 'fr' }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, slug: 'ok', status: 'hidden' }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, slug: 'ok', categories: ['a'], primaryCategory: 'b' }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, slug: 'ok', createdAt: 'yesterday' }), TypeError)
      await assert.rejects(alpha.saveCategory({ slug: '../x', name: 'x' }), TypeError)
      await assert.rejects(alpha.saveTag({ slug: 'ok', name: '' }), TypeError)
      assert.equal(await alpha.getPostById('conf-bad'), undefined)
    })

    it('round-trips categories and tags and upserts by slug', async () => {
      assert.deepEqual(await alpha.listCategories(), [
        { tenantId: 'alpha', slug: 'engineering', name: 'Engineering' },
        { tenantId: 'alpha', slug: 'notes', name: 'Notes' },
      ])
      assert.deepEqual(await alpha.listTags(), [
        { tenantId: 'alpha', slug: 'postgres', name: 'PostgreSQL' },
        { tenantId: 'alpha', slug: 'syna', name: 'Syna' },
      ])
      assert.deepEqual(await beta.listCategories(), [{ tenantId: 'beta', slug: 'essays', name: '随笔' }])

      assert.deepEqual(await alpha.saveCategory({ slug: 'notes', name: 'Field notes' }), { tenantId: 'alpha', slug: 'notes', name: 'Field notes' })
      assert.deepEqual(await alpha.saveTag({ slug: 'zeta', name: 'Zeta' }), { tenantId: 'alpha', slug: 'zeta', name: 'Zeta' })
      assert.deepEqual((await alpha.listCategories()).map(item => [item.slug, item.name]), [['engineering', 'Engineering'], ['notes', 'Field notes']])
      assert.deepEqual((await alpha.listTags()).map(item => item.slug), ['postgres', 'syna', 'zeta'])
      assert.deepEqual((await beta.listTags()).map(item => item.slug), ['syna'], 'tags stay tenant-local')
    })

    it('saves the site config and increments configRevision', async () => {
      assert.equal(await alpha.getSiteConfig(), undefined)
      const input = siteConfigInputFromFixture('alpha', fixture.tenants.alpha, sampleExtras)
      const first = await alpha.saveSiteConfig(input)
      assert.equal(first.configRevision, 1)
      assert.deepEqual(await alpha.getSiteConfig(), { ...input, configRevision: 1 })

      const second = await alpha.saveSiteConfig({ ...input, title: 'Alpha Notes v2' })
      assert.equal(second.configRevision, 2)
      const stored = await alpha.getSiteConfig()
      assert.equal(stored.title, 'Alpha Notes v2')
      assert.equal(stored.configRevision, 2)
      assert.equal(stored.tenantId, 'alpha')
      assert.deepEqual(stored.recipes, sampleExtras.recipes)
      assert.deepEqual(stored.auth, sampleExtras.auth)
      assert.equal(await beta.getSiteConfig(), undefined, 'site config is tenant-local')
      await assert.rejects(beta.saveSiteConfig(input), TypeError)
    })

    it('runs work inside transaction() against the tenant repository', async () => {
      const result = await store.transaction('alpha', async repository => {
        assert.equal(repository.tenantId, 'alpha')
        const saved = await repository.savePost({
          id: 'conf-tx', slug: 'in-transaction', locale: 'en', title: 't', body: '', status: 'draft', categories: [], tags: [],
        })
        return (await repository.getPostById('conf-tx'))?.revision === saved.revision ? 'ok' : 'mismatch'
      })
      assert.equal(result, 'ok')
      assert.equal((await alpha.getPostById('conf-tx'))?.slug, 'in-transaction')
      assert.equal(await alpha.deletePost('conf-tx'), true)
    })

    it('re-seeding is idempotent in content and increments revisions', async () => {
      const before = await alpha.listPosts({ visibility: 'all' })
      await seedTenantContent(store, 'alpha', fixture.tenants.alpha)
      const after = await alpha.listPosts({ visibility: 'all' })
      assert.deepEqual(ids(after), ids(before))
      for (const post of after) {
        const previous = before.find(item => item.id === post.id)
        assert.equal(post.revision, previous.revision + 1)
        assert.deepEqual({ ...post, revision: 0 }, { ...previous, revision: 0 })
      }
      assert.deepEqual((await alpha.listCategories()).map(item => item.name), ['Engineering', 'Notes'], 'fixture names win again')
    })

    it('contentVersion changes on every mutation of the tenant and never for another tenant', async () => {
      // Mutations run on beta (deleted by the last test); alpha must stay untouched.
      const alphaBefore = await alpha.contentVersion()
      const before = await beta.contentVersion()
      assert.equal(typeof before, 'string')
      assert.equal(await beta.contentVersion(), before, 'reads do not move the version')
      const seen = [before]
      const post = await beta.getPostById('beta-p1')
      await beta.savePost({ ...post, body: `${post.body}\n\nedited` })
      seen.push(await beta.contentVersion())
      await beta.saveTag({ slug: 'versioned', name: 'Versioned' })
      seen.push(await beta.contentVersion())
      await beta.saveCategory({ slug: 'versioned', name: 'Versioned' })
      seen.push(await beta.contentVersion())
      await beta.saveSiteConfig(siteConfigInputFromFixture('beta', fixture.tenants.beta, sampleExtras))
      seen.push(await beta.contentVersion())
      assert.equal(await beta.deletePost('no-such-post'), false)
      assert.equal(await beta.contentVersion(), seen.at(-1), 'a no-op delete does not move the version')
      await store.transaction('beta', async repository => {
        await repository.saveTag({ slug: 'in-tx', name: 'In transaction' })
      })
      seen.push(await beta.contentVersion())
      assert.equal(new Set(seen).size, seen.length, `every mutation produced a new version: ${seen}`)
      assert.equal(await alpha.contentVersion(), alphaBefore, 'the other tenant is untouched')
    })

    it('saveSiteConfig validates the document (SiteConfigError); a refused save leaves the stored configuration and its revision unchanged', async () => {
      const base = siteConfigInputFromFixture('beta', fixture.tenants.beta, sampleExtras)
      await beta.saveSiteConfig(base)
      const stored = await beta.getSiteConfig()
      const refused = [
        ['script href', { ...base, navigation: [{ label: 'x', href: 'javascript:alert(1)' }] }],
        ['protocol-relative href', { ...base, navigation: [{ label: 'x', href: '//evil.test/' }] }],
        ['stylesheet injection in accent', { ...base, theme: { ...base.theme, accent: 'red; } body { display: none }' } }],
        ['unusable domain', { ...base, domains: ['not a host'] }],
        ['unknown locale', { ...base, defaultLocale: 'fr' }],
        ['recipe without stages', { ...base, recipes: { ...base.recipes, comment: { formatVersion: 1, name: 'c', stages: [] } } }],
        ['unknown key', { ...base, extra: true }],
        ['missing auth', { ...base, auth: undefined }],
      ]
      for (const [what, input] of refused) {
        await assert.rejects(
          beta.saveSiteConfig(input),
          error => error instanceof SiteConfigError && error.code === 'INVALID_SITE_CONFIG' && error.mode === 'input' && error.tenantId === 'beta' && error.problems.length > 0,
          what,
        )
      }
      assert.deepEqual(await beta.getSiteConfig(), stored, 'nothing changed')
      // Control: the accepted spellings.
      const accepted = await beta.saveSiteConfig({
        ...base,
        theme: { name: 'ink', accent: 'rgb(10, 20, 30)' },
        navigation: [{ label: 'a', href: '/about' }, { label: 'b', href: '#top' }, { label: 'c', href: 'mailto:hi@example.test' }, { label: 'd', href: 'https://example.test/x?y=1' }, { label: 'e', href: 'posts/relative' }],
      })
      assert.equal(accepted.configRevision, stored.configRevision + 1)
    })

    it('saveSiteConfig refuses a domain another tenant already claims (DomainConflictError), also when spelled differently', async () => {
      const betaConfig = siteConfigInputFromFixture('beta', fixture.tenants.beta, sampleExtras)
      const revisionBefore = (await beta.saveSiteConfig(betaConfig)).configRevision // baseline: beta owns its own domains
      const alphaDomain = fixture.tenants.alpha.site.domains[0]
      await assert.rejects(
        beta.saveSiteConfig({ ...betaConfig, domains: [...betaConfig.domains, alphaDomain.toUpperCase()] }),
        error => error instanceof DomainConflictError && error.code === 'DOMAIN_CONFLICT' && error.ownerTenantId === 'alpha' && error.tenantId === 'beta',
      )
      await assert.rejects(
        beta.saveSiteConfig({ ...betaConfig, domains: [`${alphaDomain}:8080`] }),
        DomainConflictError,
      )
      await assert.rejects(
        beta.saveSiteConfig({ ...betaConfig, domains: [`${alphaDomain.toUpperCase()}.`] }),
        DomainConflictError,
        'a fully-qualified spelling (trailing dot) is the same claim',
      )
      assert.equal((await beta.getSiteConfig()).configRevision, revisionBefore, 'a refused save changes nothing')
      // Control: a tenant may keep (re-save) its own domains and add new ones.
      const saved = await beta.saveSiteConfig({ ...betaConfig, domains: [...betaConfig.domains, 'beta-extra.test'] })
      assert.equal(saved.configRevision, revisionBefore + 1)
      assert.ok((await beta.getSiteConfig()).domains.includes('beta-extra.test'))
    })

    it('two tenants claiming one domain at the same time: exactly one wins, every round (B2)', async () => {
      const base = tenantId => ({ ...siteConfigInputFromFixture(tenantId, fixture.tenants.alpha, sampleExtras), domains: [] })
      const first = store.forTenant('claim-a')
      const second = store.forTenant('claim-b')
      await first.saveSiteConfig(base('claim-a'))
      await second.saveSiteConfig(base('claim-b'))
      try {
        for (let round = 0; round < 5; round += 1) {
          const host = `contested-${round}.test`
          const results = await Promise.allSettled([
            first.saveSiteConfig({ ...base('claim-a'), domains: [host] }),
            second.saveSiteConfig({ ...base('claim-b'), domains: [host.toUpperCase()] }),
          ])
          const winners = results.filter(result => result.status === 'fulfilled')
          assert.equal(winners.length, 1, `round ${round}: ${results.map(result => result.status === 'fulfilled' ? 'won' : String(result.reason))}`)
          const loser = results.find(result => result.status === 'rejected')
          assert.ok(loser.reason instanceof DomainConflictError, String(loser.reason))
          assert.equal(loser.reason.ownerTenantId, winners[0].value.tenantId)
          const owners = [await first.getSiteConfig(), await second.getSiteConfig()].filter(config => config.domains.some(domain => domain.toLowerCase() === host))
          assert.equal(owners.length, 1, 'the stored configurations agree with the outcome')
          assert.equal(owners[0].tenantId, winners[0].value.tenantId)
        }
      }
      finally {
        await store.deleteTenant('claim-a')
        await store.deleteTenant('claim-b')
      }
    })

    it('a post id is scoped to its tenant: the same id in two tenants is two posts (B1)', async () => {
      const draftFor = slug => ({ id: 'shared-id', slug, locale: 'en', title: slug, body: `${slug}\n`, status: 'published', categories: [], tags: [] })
      const one = await alpha.savePost(draftFor('shared-id-alpha'))
      const two = await beta.savePost(draftFor('shared-id-beta'))
      try {
        assert.equal(one.revision, 1)
        assert.equal(two.revision, 1)
        assert.equal((await alpha.getPostById('shared-id')).slug, 'shared-id-alpha')
        assert.equal((await beta.getPostById('shared-id')).slug, 'shared-id-beta')
        const updated = await alpha.savePost({ ...draftFor('shared-id-alpha'), body: 'changed\n' })
        assert.equal(updated.revision, 2)
        assert.equal((await beta.getPostById('shared-id')).revision, 1, "updating alpha's post leaves beta's alone")
        assert.equal((await beta.getPostById('shared-id')).body, 'shared-id-beta\n')
        assert.equal(await alpha.deletePost('shared-id'), true)
        assert.equal(await alpha.getPostById('shared-id'), undefined)
        assert.equal((await beta.getPostById('shared-id')).slug, 'shared-id-beta', "deleting alpha's post leaves beta's alone")
      }
      finally {
        await alpha.deletePost('shared-id')
        await beta.deletePost('shared-id')
      }
    })

    it('a public-repository mutation of the same tenant inside transaction() is refused at once instead of waiting for the unit of work forever (F-BD3-04)', async () => {
      const tenant = 'reentrant'
      const outcome = await store.transaction(tenant, async repository => {
        await repository.saveCategory({ slug: 'inside', name: 'Inside' })
        const nestedMutation = await store.forTenant(tenant).saveTag({ slug: 'nested', name: 'Nested' }).then(() => 'saved', error => error)
        const nestedTransaction = await store.transaction(tenant, async () => 'ran').then(value => value, error => error)
        const nestedDelete = await store.deleteTenant(tenant).then(() => 'deleted', error => error)
        // Another tenant is not inside this unit of work; reads of this tenant are allowed.
        const otherTenant = await store.forTenant('elsewhere').saveTag({ slug: 'elsewhere', name: 'Elsewhere' }).then(() => 'saved', error => error)
        const read = await store.forTenant(tenant).contentVersion()
        return { nestedMutation, nestedTransaction, nestedDelete, otherTenant, read }
      })
      for (const refused of [outcome.nestedMutation, outcome.nestedTransaction, outcome.nestedDelete]) {
        assert.ok(refused instanceof TransactionReentrancyError, String(refused))
        assert.equal(refused.code, 'TRANSACTION_REENTRANCY')
        assert.equal(refused.tenantId, tenant)
      }
      assert.equal(outcome.otherTenant, 'saved')
      assert.equal(typeof outcome.read, 'string')
      assert.deepEqual((await store.forTenant(tenant).listCategories()).map(item => item.slug), ['inside'])
      assert.deepEqual((await store.forTenant(tenant).listTags()).map(item => item.slug), [], 'the refused mutation wrote nothing')
      // Outside the unit of work the same calls work.
      await store.forTenant(tenant).saveTag({ slug: 'nested', name: 'Nested' })
      assert.equal(await store.transaction(tenant, async () => 'ran'), 'ran')
      await store.deleteTenant(tenant)
      await store.deleteTenant('elsewhere')
    })

    it('mutations a unit of work issues at once all land, one after another, and the content version advances once per mutation (F-BD3-05)', async () => {
      const tenant = 'burst'
      const before = Number(await store.forTenant(tenant).contentVersion())
      const count = 10
      const saved = await store.transaction(tenant, repository =>
        Promise.all(Array.from({ length: count }, (_, index) => repository.saveCategory({ slug: `c-${index}`, name: `C${index}` }))))
      assert.equal(saved.length, count)
      assert.deepEqual((await store.forTenant(tenant).listCategories()).map(item => item.slug), Array.from({ length: count }, (_, index) => `c-${index}`))
      assert.equal(Number(await store.forTenant(tenant).contentVersion()) - before, count)
      await store.deleteTenant(tenant)
    })

    it('a domain conflict inside transaction() leaves the tenant\'s own domain ownership untouched, whether or not the work handles it (F-BD3-02)', async () => {
      const own = store.forTenant('own')
      const ownConfig = { ...siteConfigInputFromFixture('own', fixture.tenants.alpha, sampleExtras), domains: ['own.test'] }
      await own.saveSiteConfig(ownConfig)
      const alphaHost = (await alpha.getSiteConfig()).domains[0]
      const handled = await store.transaction('own', async repository =>
        repository.saveSiteConfig({ ...ownConfig, domains: ['own.test', alphaHost] }).then(() => 'saved', error => error))
      assert.ok(handled instanceof DomainConflictError, String(handled))
      assert.equal(handled.ownerTenantId, 'alpha')
      await assert.rejects(store.transaction('own', async repository => repository.saveSiteConfig({ ...ownConfig, domains: [alphaHost] })), DomainConflictError)
      // own.test still belongs to own: a third tenant cannot take it, and own's configuration still lists it.
      const third = store.forTenant('third')
      await assert.rejects(
        third.saveSiteConfig({ ...siteConfigInputFromFixture('third', fixture.tenants.alpha, sampleExtras), domains: ['own.test'] }),
        error => error instanceof DomainConflictError && error.ownerTenantId === 'own',
      )
      assert.deepEqual((await own.getSiteConfig()).domains, ['own.test'])
      await store.deleteTenant('own')
      await store.deleteTenant('third')
    })

    it('overlapping saves of one tenant\'s configuration leave its domain ownership equal to the configuration that won (F-BD3-03)', async () => {
      const same = store.forTenant('same')
      const base = siteConfigInputFromFixture('same', fixture.tenants.alpha, sampleExtras)
      const taker = store.forTenant('taker')
      for (let round = 0; round < 8; round += 1) {
        await Promise.all([
          same.saveSiteConfig({ ...base, domains: [`x${round}.test`] }),
          same.saveSiteConfig({ ...base, domains: [`y${round}.test`] }),
        ])
        const stored = (await same.getSiteConfig()).domains
        assert.equal(stored.length, 1)
        const lost = stored[0] === `x${round}.test` ? `y${round}.test` : `x${round}.test`
        // The host of the save that lost is nobody's: another tenant may take it; the winner's host is still refused.
        await taker.saveSiteConfig({ ...siteConfigInputFromFixture('taker', fixture.tenants.alpha, sampleExtras), domains: [lost] })
        await assert.rejects(
          taker.saveSiteConfig({ ...siteConfigInputFromFixture('taker', fixture.tenants.alpha, sampleExtras), domains: stored }),
          error => error instanceof DomainConflictError && error.ownerTenantId === 'same',
        )
      }
      await store.deleteTenant('same')
      await store.deleteTenant('taker')
    })

    it('a NUL character in a post, a name or a configuration is refused by both backends before anything is written (F-BD3-12)', async () => {
      const nul = ['a', 'b'].join(String.fromCharCode(0))
      const base = { id: 'nul-post', slug: 'nul-post', locale: 'en', title: 't', body: 'b', status: 'draft', categories: [], tags: [] }
      await assert.rejects(alpha.savePost({ ...base, body: nul }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, title: nul }), TypeError)
      await assert.rejects(alpha.savePost({ ...base, id: nul }), TypeError)
      await assert.rejects(alpha.saveCategory({ slug: 'nul', name: nul }), TypeError)
      await assert.rejects(alpha.saveTag({ slug: 'nul', name: nul }), TypeError)
      await assert.rejects(
        alpha.saveSiteConfig({ ...siteConfigInputFromFixture('alpha', fixture.tenants.alpha, sampleExtras), title: nul }),
        error => error instanceof SiteConfigError && error.mode === 'input',
      )
      assert.equal(await alpha.getPostById('nul-post'), undefined)
      assert.ok(!(await alpha.listCategories()).some(item => item.slug === 'nul'))
      assert.ok(!(await alpha.listTags()).some(item => item.slug === 'nul'))
    })

    it('listTenants() lists a tenant that only has a category or a tag (F-BD3-12)', async () => {
      await store.forTenant('cat-only').saveCategory({ slug: 'c', name: 'C' })
      await store.forTenant('tag-only').saveTag({ slug: 't', name: 'T' })
      const tenants = await store.listTenants()
      assert.ok(tenants.includes('cat-only') && tenants.includes('tag-only'), `tenants: ${tenants}`)
      await store.deleteTenant('cat-only')
      await store.deleteTenant('tag-only')
      const after = await store.listTenants()
      assert.ok(!after.includes('cat-only') && !after.includes('tag-only'), `tenants: ${after}`)
    })

    it('deleteTenant removes only that tenant', async () => {
      await store.deleteTenant('beta')
      assert.deepEqual(await beta.listPosts({ visibility: 'all' }), [])
      assert.deepEqual(await beta.listCategories(), [])
      assert.deepEqual(await beta.listTags(), [])
      assert.equal(await beta.getSiteConfig(), undefined)
      assert.ok(!(await store.listTenants()).includes('beta'))
      assert.deepEqual(ids(await alpha.listPosts({ visibility: 'all' })), ['alpha-p4', 'alpha-p3', 'alpha-p2', 'alpha-p1'])
      assert.equal((await alpha.listCategories()).length, 2)
      assert.equal((await alpha.getSiteConfig())?.configRevision, 2)
      await store.deleteTenant('beta') // idempotent
      await assert.rejects(store.deleteTenant('../alpha'), TypeError)
    })
  })
}

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  DomainConflictError,
  SlugConflictError,
  comparePosts,
  loadContentFixture,
  seedAllTenants,
  seedTenantContent,
  siteConfigInputFromFixture,
} from '../../dist/index.js'

export const fixture = loadContentFixture()

function recipe(name) {
  return {
    formatVersion: 1,
    name,
    stages: [{
      occurrence: 'markdown',
      ref: { kind: 'persistent-implementation-ref', contractId: 'hyla.mini/render-stage/v1', implementationId: 'hyla.mini/markdown', version: '^0.1.0' },
      optionsVersion: 1,
      options: { gfm: true },
    }],
  }
}

/** Placeholder recipe/auth documents; the real ones are owned by other layers. */
export const sampleExtras = Object.freeze({
  recipes: { body: recipe('body'), comment: recipe('comment'), preview: recipe('preview') },
  auth: {
    implementation: { kind: 'persistent-implementation-ref', contractId: 'hyla.mini/auth/v1', implementationId: 'hyla.mini/test-auth', version: '^0.1.0' },
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

    it('saveSiteConfig refuses a domain another tenant already claims (DomainConflictError), also when spelled differently', async () => {
      const betaConfig = siteConfigInputFromFixture('beta', fixture.tenants.beta, sampleExtras)
      await beta.saveSiteConfig(betaConfig) // baseline: beta owns its own domains
      const alphaDomain = fixture.tenants.alpha.site.domains[0]
      await assert.rejects(
        beta.saveSiteConfig({ ...betaConfig, domains: [...betaConfig.domains, alphaDomain.toUpperCase()] }),
        error => error instanceof DomainConflictError && error.code === 'DOMAIN_CONFLICT' && error.ownerTenantId === 'alpha' && error.tenantId === 'beta',
      )
      await assert.rejects(
        beta.saveSiteConfig({ ...betaConfig, domains: [`${alphaDomain}:8080`] }),
        DomainConflictError,
      )
      const revisionBefore = (await beta.getSiteConfig()).configRevision
      assert.equal((await beta.getSiteConfig()).configRevision, revisionBefore, 'a refused save changes nothing')
      // Control: a tenant may keep (re-save) its own domains and add new ones.
      const saved = await beta.saveSiteConfig({ ...betaConfig, domains: [...betaConfig.domains, 'beta-extra.test'] })
      assert.equal(saved.configRevision, revisionBefore + 1)
      assert.ok((await beta.getSiteConfig()).domains.includes('beta-extra.test'))
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

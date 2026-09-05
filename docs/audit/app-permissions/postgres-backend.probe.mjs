// Attack 10 (PostgreSQL): rollback, concurrent transactions across and within a tenant, cross-tenant id hijack, slug collisions, injection-shaped filters.
// Run wrapped: SYNA_PG_CLUSTER_DIR=... node scripts/pg-test-cluster.mjs with -- node work/v05/audit/app-permissions/postgres-backend.probe.mjs
import { createPostgresApp } from '../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 90_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const harness = await createPostgresApp()
try {
  const store = await harness.app.app.deps.store.load()
  const alpha = store.forTenant('alpha')
  const beta = store.forTenant('beta')
  const base = { locale: 'en', title: 't', body: 'b', status: 'published', categories: [], tags: [], createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }

  // 1. rollback on throw
  const rollback = await settled(store.transaction('alpha', async repository => {
    await repository.savePost({ ...base, id: 'tx-rollback', slug: 'tx-rollback' })
    await repository.saveCategory({ slug: 'txcat', name: 'Tx' })
    await repository.saveTag({ slug: 'txtag', name: 'Tx' })
    throw new Error('boom')
  }))
  check('transaction rejects with the thrown error', !rollback.ok && /boom/.test(rollback.error.message))
  check('rolled back: post, category and tag absent', (await alpha.getPostById('tx-rollback')) === undefined
    && !(await alpha.listCategories()).some(category => category.slug === 'txcat')
    && !(await alpha.listTags()).some(tag => tag.slug === 'txtag'))

  // 2. two concurrent transactions on different tenants using the same slug
  const [alphaSame, betaSame] = await Promise.all([
    store.transaction('alpha', repository => repository.savePost({ ...base, id: 'a-same', slug: 'same' })),
    store.transaction('beta', repository => repository.savePost({ ...base, id: 'b-same', slug: 'same' })),
  ])
  check('different tenants may hold the same slug concurrently', alphaSame.tenantId === 'alpha' && betaSame.tenantId === 'beta'
    && (await alpha.getPost('same', { visibility: 'all' })).id === 'a-same' && (await beta.getPost('same', { visibility: 'all' })).id === 'b-same')

  // 3. same tenant, two concurrent transactions racing for one slug
  const race = await Promise.all([
    settled(store.transaction('alpha', async repository => { const post = await repository.savePost({ ...base, id: 'race-1', slug: 'race' }); await sleep(40); return post })),
    settled(store.transaction('alpha', async repository => { await sleep(5); return repository.savePost({ ...base, id: 'race-2', slug: 'race' }) })),
  ])
  const winners = race.filter(result => result.ok).length
  const conflicts = race.filter(result => !result.ok && result.error.name === 'SlugConflictError').length
  check('same-tenant slug race: exactly one winner and one SlugConflictError', winners === 1 && conflicts === 1, race.map(result => result.ok ? `ok ${result.value.id}` : `${result.error.name}: ${result.error.message.slice(0, 90)}`))
  check('exactly one row holds slug "race"', (await alpha.listPosts({ visibility: 'all' })).filter(post => post.slug === 'race').length === 1)

  // 4. cross-tenant id. When this probe was written the PostgreSQL store refused a save whose id another tenant
  // held ("another tenant"); since I-78 (D51) a post id is scoped to its tenant on both backends, so the same id
  // in two tenants is two posts and neither can reach the other's row.
  const victimBefore = await alpha.getPostById('alpha-p1')
  const sameId = await settled(beta.savePost({ ...base, id: 'alpha-p1', slug: 'hijacked' }))
  const victimAfter = await alpha.getPostById('alpha-p1')
  check('savePost with an id another tenant also uses creates the caller\'s own post (I-78)', sameId.ok && sameId.value.tenantId === 'beta' && sameId.value.slug === 'hijacked', sameId.ok ? `${sameId.value.tenantId}/${sameId.value.slug}` : sameId.error.message)
  check('the other tenant\'s row is untouched', JSON.stringify(victimAfter) === JSON.stringify(victimBefore))
  const betaView = await beta.getPostById('alpha-p1')
  check('beta.getPostById(shared id) → beta\'s own post, never alpha\'s', betaView?.tenantId === 'beta' && betaView?.slug === 'hijacked', betaView && `${betaView.tenantId}/${betaView.slug}`)
  check('beta.deletePost(shared id) deletes beta\'s post only; alpha\'s row remains', (await beta.deletePost('alpha-p1')) === true && (await beta.getPostById('alpha-p1')) === undefined && JSON.stringify(await alpha.getPostById('alpha-p1')) === JSON.stringify(victimBefore))
  const sameIdTx = await settled(store.transaction('beta', repository => repository.savePost({ ...base, id: 'alpha-p2', slug: 'hijacked-tx' })))
  check('same id inside a transaction: beta\'s own post committed, alpha\'s untouched', sameIdTx.ok && (await alpha.getPostById('alpha-p2')).slug === 'shared-slug' && (await beta.getPost('hijacked-tx', { visibility: 'all' }))?.id === 'alpha-p2', sameIdTx.ok ? 'committed' : sameIdTx.error.message)
  check('beta cannot read alpha private post by slug', (await beta.getPost('members-only', { visibility: 'all' })) === undefined)

  // 5. slug collision within a tenant
  const collision = await settled(alpha.savePost({ ...base, id: 'alpha-new', slug: 'hello-world' }))
  check('slug collision within a tenant → SlugConflictError', !collision.ok && collision.error.name === 'SlugConflictError', collision.ok ? 'accepted' : collision.error.message)

  // 6. tenant-id and filter validation
  check('forTenant rejects an unsafe tenant id', (() => { try { store.forTenant("alpha'; drop table posts--"); return false } catch { return true } })())
  check('transaction rejects an unsafe tenant id', !(await settled(store.transaction("alpha' or 1=1", async () => 1))).ok)
  check('deleteTenant rejects an unsafe tenant id', !(await settled(store.deleteTenant('../alpha'))).ok)
  const injected = await alpha.listPosts({ visibility: 'all', category: "x' or '1'='1" })
  check('category filter is parameterised (injection-shaped value matches nothing)', injected.length === 0, injected.length)
  const injectedTag = await alpha.listPosts({ visibility: 'all', tag: 'syna) or true--' })
  check('tag filter is parameterised', injectedTag.length === 0, injectedTag.length)
  const badConfig = await settled(beta.saveSiteConfig({ ...(await alpha.getSiteConfig()), tenantId: 'alpha' }))
  check('saveSiteConfig with another tenantId is rejected', !badConfig.ok)
  check('getSiteConfig stamps the repository tenant', (await beta.getSiteConfig()).tenantId === 'beta')

  // 7. update semantics
  const p1 = await alpha.getPostById('alpha-p1')
  const updated = await alpha.savePost({ ...p1, createdAt: undefined, updatedAt: undefined, title: 'edited' })
  check('update increments revision and preserves createdAt', updated.revision === p1.revision + 1 && updated.createdAt === p1.createdAt && updated.title === 'edited', { before: p1.revision, after: updated.revision })
  const concurrent = await Promise.all(Array.from({ length: 10 }, (_, index) => alpha.savePost({ ...p1, createdAt: undefined, updatedAt: undefined, title: `c${index}` })))
  const revisions = concurrent.map(post => post.revision).sort((left, right) => left - right)
  check('10 concurrent updates of one row produce 10 distinct increasing revisions', new Set(revisions).size === 10 && revisions[0] === updated.revision + 1, revisions)
  check('listTenants lists both tenants only', JSON.stringify(await store.listTenants()) === JSON.stringify(['alpha', 'beta']), await store.listTenants())
}
finally {
  await harness.close()
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

// B1: the same post id in two tenants must be two posts on both backends (PostgreSQL only when SYNA_TEST_PG_URL is set).
import { createFilesystemApp, createPostgresApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const draft = slug => ({ id: 'shared-id', slug, locale: 'en', title: slug, body: `${slug}\n`, status: 'published', categories: [], tags: [] })
async function probe(label, harness) {
  try {
    const store = await harness.app.app.deps.store.load()
    const alpha = store.forTenant('alpha')
    const beta = store.forTenant('beta')
    await alpha.savePost(draft('shared-id-alpha'))
    const second = await beta.savePost(draft('shared-id-beta')).then(() => 'saved', error => error.message)
    const alphaSlug = (await alpha.getPostById('shared-id'))?.slug
    const betaSlug = (await beta.getPostById('shared-id'))?.slug
    check(`${label}: the same id in two tenants is two posts`, second === 'saved' && alphaSlug === 'shared-id-alpha' && betaSlug === 'shared-id-beta', { second, alphaSlug, betaSlug })
    await alpha.deletePost('shared-id')
    await beta.deletePost('shared-id')
  }
  finally {
    await harness.close()
  }
}
await probe('filesystem', await createFilesystemApp())
if (process.env.SYNA_TEST_PG_URL) await probe('postgres', await createPostgresApp())
else console.log('postgres: skipped (SYNA_TEST_PG_URL not set; run through scripts/pg-test-cluster.mjs with -- …)')
process.exitCode = failed === 0 ? 0 : 1

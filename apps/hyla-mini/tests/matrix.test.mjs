// H04 — two real backends × two execution modes with one content/render main line.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BuildEntry, startHttpServer, startStaticServer } from '../dist/index.js'
import { createFilesystemApp, createPostgresApp, fetchText, normalizePage } from './helpers/app-harness.mjs'

async function dynamicPages(harness) {
  const domains = await harness.app.domains()
  const server = await startHttpServer({ app: harness.app.app, domains })
  try {
    const get = (host, route) => fetchText(`${server.url}${route}`, { headers: { host } })
    const pages = {
      index: await get('alpha.test', '/'),
      shared: await get('alpha.test', '/posts/shared-slug'),
      hello: await get('alpha.test', '/posts/hello-world'),
      category: await get('alpha.test', '/category/engineering'),
      draft: await get('alpha.test', '/posts/draft-plans'),
      privatePost: await get('alpha.test', '/posts/members-only'),
      betaShared: await get('beta.test', '/posts/shared-slug'),
      siteJson: await get('alpha.test', '/site.json'),
    }
    assert.equal(pages.index.status, 200)
    assert.equal(pages.shared.status, 200)
    assert.equal(pages.draft.status, 404, 'drafts are not public over HTTP')
    assert.equal(pages.privatePost.status, 404, 'private posts are not public over HTTP')
    assert.equal(pages.shared.headers.get('x-hyla-tenant'), 'alpha')
    return pages
  }
  finally {
    await server.close()
  }
}

async function staticPages(harness) {
  const outputDir = await mkdtemp(path.join(tmpdir(), `hyla-static-${harness.kind}-`))
  const manager = await harness.app.app.deps.sites.load()
  const lease = await manager.acquire('alpha', 'build')
  let manifest
  try {
    manifest = await lease.env.run(BuildEntry, { build: { outputDir } }, async ({ builder }) => (await builder.load()).build())
  }
  finally {
    lease.release()
  }
  assert.deepEqual(manifest.files, [
    'category/engineering/index.html',
    'category/notes/index.html',
    'index.html',
    'posts/hello-world/index.html',
    'posts/shared-slug/index.html',
    'site.json',
  ])
  const all = await Promise.all(manifest.files.map(file => readFile(path.join(outputDir, file), 'utf8')))
  for (const content of all) {
    assert.doesNotMatch(content, /ALPHA-DRAFT-SECRET|ALPHA-PRIVATE-SECRET|BETA-PRIVATE-SECRET/, 'no draft/private content in static output')
    assert.doesNotMatch(content, /alpha-member|alpha-editor|beta-test-secret|hyla_app_|postgres:\/\//, 'no credentials or internal refs in static output')
  }
  const server = await startStaticServer(outputDir)
  try {
    const served = {
      index: await fetchText(`${server.url}/`),
      shared: await fetchText(`${server.url}/posts/shared-slug/`),
      hello: await fetchText(`${server.url}/posts/hello-world/`),
      category: await fetchText(`${server.url}/category/engineering/`),
      missingDraft: await fetchText(`${server.url}/posts/draft-plans/`),
    }
    assert.equal(served.shared.status, 200)
    assert.equal(served.missingDraft.status, 404)
    assert.equal((await readdir(outputDir)).sort().join(','), 'category,index.html,posts,site.json')
    return { served, manifest, outputDir }
  }
  finally {
    await server.close()
    await rm(outputDir, { recursive: true, force: true })
  }
}

async function runMatrixCell(harness) {
  const dynamic = await dynamicPages(harness)
  const stat = await staticPages(harness)
  // Same renderer, same recipes: the public HTML of a post is byte-identical between HTTP and static export.
  assert.equal(normalizePage(stat.served.shared.body), normalizePage(dynamic.shared.body))
  assert.equal(normalizePage(stat.served.hello.body), normalizePage(dynamic.hello.body))
  assert.equal(normalizePage(stat.served.category.body), normalizePage(dynamic.category.body))
  assert.equal(normalizePage(stat.served.index.body), normalizePage(dynamic.index.body))
  assert.match(dynamic.shared.body, /Alpha content for the slug/)
  assert.match(dynamic.betaShared.body, /租户的内容。两个租户使用了同一个 slug/)
  assert.notEqual(normalizePage(dynamic.shared.body), normalizePage(dynamic.betaShared.body))
  return { dynamic, static: stat }
}

test('H04 PostgreSQL → HTTP and PostgreSQL → static files render the same public content', async () => {
  const harness = await createPostgresApp()
  try {
    const result = await runMatrixCell(harness)
    assert.equal(JSON.parse(result.dynamic.siteJson.body).tenantId, 'alpha')
  }
  finally {
    await harness.close()
  }
})

test('H04 filesystem → HTTP and filesystem → static files render the same public content', async () => {
  const harness = await createFilesystemApp()
  try {
    await runMatrixCell(harness)
  }
  finally {
    await harness.close()
  }
})

test('H04 the two backends produce identical public pages for identical fixtures', async () => {
  const pgHarness = await createPostgresApp()
  const fsHarness = await createFilesystemApp()
  try {
    const [pgPages, fsPages] = await Promise.all([dynamicPages(pgHarness), dynamicPages(fsHarness)])
    for (const key of ['index', 'shared', 'hello', 'category', 'betaShared']) {
      assert.equal(normalizePage(fsPages[key].body), normalizePage(pgPages[key].body), `page ${key} equal across backends`)
    }
  }
  finally {
    await Promise.all([pgHarness.close(), fsHarness.close()])
  }
})

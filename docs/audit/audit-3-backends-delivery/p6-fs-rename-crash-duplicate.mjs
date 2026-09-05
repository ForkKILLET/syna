// p6 — Filesystem: a crash inside a slug rename leaves two files with one id; the pending-version
// marker repairs the caches (documented, I-80) but not the content, and nothing ever repairs it.
//
// savePost writes the new file, then removes the old one (store.ts: "The new file is on disk before
// the old one goes away"). A crash between the two leaves both. After the marker's bump the post is
// listed twice, its old slug still serves the old body, a later save of the post keeps the stale
// copy (the "previous" file is whichever sorts first), and deletePost removes only one copy — the
// post comes back. docs/AUDIT.md:78 says such a crash "is repaired by the pending-version marker at
// the next read"; only the cache is.
//
// Run: node <this file>
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime } from '@syna/core'
import { BlogLayout, ContentLayoutChoice, ContentRoot, DefaultLayout, FilesystemContentStore, define, serializePost } from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
const draft = (id, extra = {}) => ({ id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'published', categories: [], tags: [], ...extra })

const FsEntry = define.entry('audit3-p6-filesystem', { requires: { store: FilesystemContentStore }, parameters: { root: ContentRoot, layout: ContentLayoutChoice } })
const runtime = createRuntime({ services: [FilesystemContentStore, DefaultLayout, BlogLayout] })
const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit3-p6-'))
try {
  const env = await runtime.enter(FsEntry, { root: { rootDir }, layout: ContentLayoutChoice.to(DefaultLayout) })
  const store = await env.deps.store.load()
  const repository = store.forTenant('crash')
  await repository.savePost(draft('dup', { slug: 'z-old', body: 'old body\n' }))
  const before = Number(await repository.contentVersion())

  // The crash window of a rename z-old → a-new: marker set, new file written, old file not yet removed.
  const renamed = { ...(await repository.getPostById('dup')), slug: 'a-new', body: 'new body\n', revision: 2 }
  await writeFile(path.join(rootDir, 'crash', 'posts', 'a-new.md'), serializePost(renamed))
  await writeFile(path.join(rootDir, 'crash', 'content.version.pending'), `${new Date().toISOString()}\n`)

  const after = Number(await repository.contentVersion())
  check('the leftover marker bumps the version once (the documented cache repair)', after === before + 1, { before, after })
  const listed = await repository.listPosts({ visibility: 'public' })
  console.log(`listPosts after the repair: ${JSON.stringify(listed.map(post => [post.id, post.slug, post.revision, post.body.trim()]))}`)
  check('after the repair the post id appears once in listPosts', listed.filter(post => post.id === 'dup').length === 1, listed.map(post => `${post.id}@${post.slug}`))
  check('after the repair the old slug no longer resolves publicly', await repository.getPost('z-old', { visibility: 'public' }) === undefined, (await repository.getPost('z-old', { visibility: 'public' }))?.body)

  // The author saves the post again under its new slug: the stale copy should go away.
  const saved = await repository.savePost(draft('dup', { slug: 'a-new', body: 'new body 2\n' }))
  const files = (await readdir(path.join(rootDir, 'crash', 'posts'))).sort()
  console.log(`after re-saving dup as a-new (revision ${saved.revision}): files ${JSON.stringify(files)}`)
  check('re-saving the post removes the stale copy', !files.includes('z-old.md'), files)

  const deleted = await repository.deletePost('dup')
  const remaining = await repository.getPostById('dup')
  const filesAfterDelete = (await readdir(path.join(rootDir, 'crash', 'posts'))).sort()
  console.log(`deletePost('dup') → ${deleted}; getPostById afterwards → ${remaining ? `${remaining.slug} (${remaining.body.trim()})` : 'undefined'}; files ${JSON.stringify(filesAfterDelete)}`)
  check('deletePost removes every copy of the post', deleted && remaining === undefined, { deleted, remaining: remaining?.slug, files: filesAfterDelete })
}
finally {
  await runtime.dispose()
  await rm(rootDir, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1

// Attack 9: filesystem backend — traversal, symlinks, concurrent saves, slug + primary-category rename under the blog layout.
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHylaApp } from '../../../../apps/hyla-mini/dist/index.js'
import { seedApp } from '../../../../apps/hyla-mini/tests/helpers/app-harness.mjs'

let failed = 0
const check = (name, ok, observed) => {
  failed += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`)
}
const watchdog = setTimeout(() => { console.log('FAIL probe timed out'); process.exit(2) }, 60_000)
const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
const exists = file => stat(file).then(() => true, () => false)
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...await walk(full))
    else out.push(full)
  }
  return out
}

const rootDir = await mkdtemp(path.join(tmpdir(), 'hyla-audit-fs-'))
const app = await createHylaApp({ backend: { kind: 'filesystem', rootDir, layout: 'blog' } })
try {
  await seedApp(app)
  const store = await app.app.deps.store.load()
  const alpha = store.forTenant('alpha')
  const manager = await app.app.deps.sites.load()
  const base = { locale: 'en', title: 't', body: 'b', status: 'published', categories: ['notes'], tags: [], createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }

  // traversal-shaped identifiers
  for (const tenantId of ['../alpha', 'alpha/..', '..', '.', 'Alpha', 'alpha\0', '/alpha', 'a b']) {
    const sync = (() => { try { store.forTenant(tenantId); return 'accepted' } catch (error) { return error.constructor.name } })()
    const tx = await settled(store.transaction(tenantId, async () => 1))
    check(`tenant id ${JSON.stringify(tenantId)} rejected by forTenant and transaction`, sync !== 'accepted' && !tx.ok, { sync, tx: tx.ok ? 'accepted' : tx.error.constructor.name })
  }
  check('deleteTenant("../alpha") rejected', !(await settled(store.deleteTenant('../alpha'))).ok)
  for (const slug of ['a/b', '../x', 'A-B', 'x\\y', '', 'x.md', '..']) {
    const saved = await settled(alpha.savePost({ ...base, id: 'bad', slug }))
    check(`slug ${JSON.stringify(slug)} rejected`, !saved.ok && !(await exists(path.join(rootDir, 'alpha', 'posts', 'notes', `${slug}.md`))), saved.ok ? 'accepted' : saved.error.constructor.name)
  }
  check('category slug with "/" rejected', !(await settled(alpha.saveCategory({ slug: 'a/b', name: 'x' }))).ok)
  check('post id with ".." rejected', !(await settled(alpha.savePost({ ...base, id: '../evil', slug: 'evil' }))).ok)
  check('primaryCategory traversal rejected', !(await settled(alpha.savePost({ ...base, id: 'pc', slug: 'pc', categories: ['notes'], primaryCategory: '../x' }))).ok)

  // symlinked tenant directory
  await symlink(path.join(rootDir, 'alpha'), path.join(rootDir, 'gamma'))
  const tenants = await store.listTenants()
  check('listTenants excludes a symlinked tenant directory', !tenants.includes('gamma'), tenants)
  const gammaPosts = await settled(store.forTenant('gamma').listPosts({ visibility: 'all' }))
  const gammaConfig = await settled(store.forTenant('gamma').getSiteConfig())
  const gammaAcquire = await settled(manager.acquire('gamma', 'request'))
  check('reading through a symlinked tenant dir is refused (posts, site config, acquire)', !gammaPosts.ok && gammaPosts.error.name === 'UnsafePathError' && !gammaConfig.ok && !gammaAcquire.ok, { posts: gammaPosts.ok ? 'read' : gammaPosts.error.name, config: gammaConfig.ok ? 'read' : gammaConfig.error.name, acquire: gammaAcquire.ok ? 'ok' : gammaAcquire.error.name })
  const gammaWrite = await settled(store.forTenant('gamma').savePost({ ...base, id: 'via-symlink', slug: 'via-symlink' }))
  check('writing through a symlinked tenant dir is refused', !gammaWrite.ok && !(await exists(path.join(rootDir, 'alpha', 'posts', 'notes', 'via-symlink.md'))), gammaWrite.ok ? 'written' : gammaWrite.error.name)
  await unlink(path.join(rootDir, 'gamma'))

  // symlinked post file and symlinked directory pointing outside the root
  const notesDir = path.join(rootDir, 'alpha', 'posts', 'notes')
  await symlink(path.join(notesDir, 'shared-slug.md'), path.join(notesDir, 'evil.md'))
  const withLinkedFile = await settled(alpha.listPosts({ visibility: 'all' }))
  check('a symlinked post file makes the scan refuse (documented policy: no symlinks below the root)', !withLinkedFile.ok && withLinkedFile.error.name === 'UnsafePathError', withLinkedFile.ok ? `read ${withLinkedFile.value.length}` : withLinkedFile.error.message.slice(0, 100))
  await unlink(path.join(notesDir, 'evil.md'))
  await symlink('/etc', path.join(rootDir, 'alpha', 'posts', 'outside'))
  const withLinkedDir = await settled(alpha.listPosts({ visibility: 'all' }))
  check('a symlinked directory pointing outside the root is refused, never followed', !withLinkedDir.ok && withLinkedDir.error.name === 'UnsafePathError', withLinkedDir.ok ? 'read' : withLinkedDir.error.name)
  await unlink(path.join(rootDir, 'alpha', 'posts', 'outside'))
  check('tenant readable again once the symlinks are gone', (await settled(alpha.listPosts({ visibility: 'all' }))).ok)

  // concurrent saves
  const p2 = await alpha.getPostById('alpha-p2')
  const updates = await Promise.all(Array.from({ length: 20 }, (_, index) => alpha.savePost({ ...p2, createdAt: undefined, updatedAt: undefined, title: `t${index}` })))
  const finalP2 = await alpha.getPostById('alpha-p2')
  check('20 concurrent updates of one post: revision advanced by exactly 20 (no lost update)', finalP2.revision === p2.revision + 20 && new Set(updates.map(post => post.revision)).size === 20, { before: p2.revision, after: finalP2.revision })
  await Promise.all(Array.from({ length: 20 }, (_, index) => alpha.savePost({ ...base, id: `bulk-${index}`, slug: `bulk-${index}` })))
  check('20 concurrent creates all land', (await alpha.listPosts({ visibility: 'all' })).filter(post => post.slug.startsWith('bulk-')).length === 20)
  const race = await Promise.all([settled(alpha.savePost({ ...base, id: 'r1', slug: 'race' })), settled(alpha.savePost({ ...base, id: 'r2', slug: 'race' }))])
  check('concurrent creates racing for one slug: one wins, one SlugConflictError', race.filter(result => result.ok).length === 1 && race.filter(result => !result.ok && result.error.name === 'SlugConflictError').length === 1, race.map(result => result.ok ? result.value.id : result.error.name))
  const raceFiles = (await walk(path.join(rootDir, 'alpha', 'posts'))).filter(file => file.endsWith('race.md'))
  check('exactly one race.md on disk', raceFiles.length === 1, raceFiles.map(file => path.relative(rootDir, file)))

  // slug + primary category rename under the blog layout
  const p1 = await alpha.getPostById('alpha-p1') // hello-world, primary engineering
  const oldFile = path.join(rootDir, 'alpha', 'posts', 'engineering', 'hello-world.md')
  check('precondition: hello-world lives under posts/engineering', await exists(oldFile))
  const renamed = await alpha.savePost({ ...p1, createdAt: undefined, updatedAt: undefined, slug: 'hello-again', categories: ['notes', 'engineering'], primaryCategory: 'notes' })
  const newFile = path.join(rootDir, 'alpha', 'posts', 'notes', 'hello-again.md')
  check('renamed file exists under the new primary category and the old file is gone', (await exists(newFile)) && !(await exists(oldFile)))
  check('identity, revision and createdAt preserved across the rename', renamed.id === 'alpha-p1' && renamed.revision === p1.revision + 1 && renamed.createdAt === p1.createdAt, { id: renamed.id, rev: [p1.revision, renamed.revision] })
  const frontMatter = await readFile(newFile, 'utf8')
  check('front matter carries the stable id', /^id: alpha-p1$/m.test(frontMatter))
  check('old slug no longer resolves; new slug does; getPostById finds the moved post', (await alpha.getPost('hello-world', { visibility: 'all' })) === undefined && (await alpha.getPost('hello-again', { visibility: 'all' }))?.id === 'alpha-p1' && (await alpha.getPostById('alpha-p1'))?.slug === 'hello-again')
  const countAfter = (await alpha.listPosts({ visibility: 'all' })).filter(post => post.id === 'alpha-p1').length
  check('no duplicate record after the rename', countAfter === 1, countAfter)
  const back = await alpha.savePost({ ...renamed, createdAt: undefined, updatedAt: undefined, slug: 'hello-world', categories: ['engineering', 'notes'], primaryCategory: 'engineering' })
  check('rename back restores the original path and keeps the id', back.id === 'alpha-p1' && (await exists(oldFile)) && !(await exists(newFile)))
  const swap = await settled(alpha.savePost({ ...p2, createdAt: undefined, updatedAt: undefined, slug: 'bulk-0' }))
  check('taking another post\'s slug is a SlugConflictError', !swap.ok && swap.error.name === 'SlugConflictError', swap.ok ? 'accepted' : swap.error.name)
  // moving a post to an uncategorised state under the blog layout
  const uncategorised = await alpha.savePost({ ...base, id: 'nocat', slug: 'nocat', categories: [] })
  check('uncategorised post lands in posts/_uncategorized', uncategorised.primaryCategory === undefined && await exists(path.join(rootDir, 'alpha', 'posts', '_uncategorized', 'nocat.md')))

  // transaction serialisation and no temp files
  const txResult = await store.transaction('alpha', async repository => {
    const post = await repository.savePost({ ...base, id: 'tx1', slug: 'tx1' })
    await repository.saveCategory({ slug: 'txcat', name: 'Tx' })
    return post
  })
  check('transaction() works with nested mutations (no self-deadlock)', txResult.id === 'tx1' && (await alpha.listCategories()).some(category => category.slug === 'txcat'))
  const partial = await settled(store.transaction('alpha', async repository => { await repository.savePost({ ...base, id: 'tx2', slug: 'tx2' }); throw new Error('half-way') }))
  check('DOCUMENTED LIMITATION: filesystem transaction has no rollback (tx2 remains after a throw)', !partial.ok && (await alpha.getPostById('tx2')) !== undefined)
  const tmpFiles = (await walk(rootDir)).filter(file => file.endsWith('.tmp'))
  check('no temp files left behind', tmpFiles.length === 0, tmpFiles)
  check('beta untouched by all alpha activity', (await store.forTenant('beta').listPosts({ visibility: 'all' })).length === 3)
}
finally {
  await app.close()
  await rm(rootDir, { recursive: true, force: true })
  clearTimeout(watchdog)
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  setTimeout(() => { console.log(`FAIL process still alive 5s after close: ${process.getActiveResourcesInfo()}`); process.exit(1) }, 5000).unref()
  process.exitCode = failed === 0 ? 0 : 1
}

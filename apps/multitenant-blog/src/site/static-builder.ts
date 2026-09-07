import { lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { define } from '../syna.js'
import { ANONYMOUS } from '../auth/principal.js'
import { KeyedMutex, UnsafePathError, assertNoSymlink, writeFileAtomic } from '../data/filesystem/files.js'
import { SiteContext } from './context.js'
import { BuildOptions } from './inputs.js'

export interface StaticBuildManifest {
  readonly tenantId: string
  readonly configRevision: number
  /** Content version every page of this build was rendered from (read before and after rendering; the two agreed). */
  readonly contentVersion: string
  /** Absolute output directory with symbolic links above it resolved. */
  readonly outputDir: string
  /** Relative file paths written, sorted. */
  readonly files: readonly string[]
  readonly pages: readonly { readonly path: string; readonly kind: string; readonly postIds: readonly string[] }[]
  /** Render passes it took to get a consistent snapshot: 1 unless the content moved while pages were rendered. */
  readonly attempts: number
}

export interface StaticBuilder {
  build(): Promise<StaticBuildManifest>
}

export type StaticBuildErrorCode =
  /** The output directory (or a path below it) is or crosses a symbolic link, or a manifest entry points outside it. */
  | 'UNSAFE_OUTPUT_DIR'
  /** A non-empty directory without a previous build of this builder. */
  | 'OUTPUT_DIR_NOT_EMPTY'
  /** The on-disk build manifest is not one this builder wrote for this tenant (`builder`, `tenantId`, file list). */
  | 'BAD_MANIFEST'
  /** Another build of the same directory is running (`.hyla-build.lock` held by a live process). */
  | 'BUILD_LOCKED'
  /** The content version kept moving while pages were rendered; nothing was written. */
  | 'BUILD_CONTENT_CHANGED'

export class StaticBuildError extends Error {
  override readonly name = 'StaticBuildError'
  constructor(readonly code: StaticBuildErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

const isSafeOutputDir = (dir: string): boolean => path.isAbsolute(dir) && dir.split(path.sep).filter(Boolean).length >= 2

/** Records what a build wrote so the next build removes exactly that and nothing else. */
export const BUILD_MANIFEST_FILE = '.hyla-build.json'
/** Held for the duration of a build; `{ pid, startedAt }`. Never published, never listed in the manifest. */
export const BUILD_LOCK_FILE = '.hyla-build.lock'
/** A lock older than this is considered left behind by a crashed build, whatever its pid says. */
export const BUILD_LOCK_STALE_MS = 10 * 60_000
/** Render passes before a build gives up on a content version that keeps moving. */
export const BUILD_SNAPSHOT_ATTEMPTS = 3

const BUILD_OWN_FILES: ReadonlySet<string> = new Set([BUILD_MANIFEST_FILE, BUILD_LOCK_FILE])

/** Process-wide: builders of any Runtime or tenant never write one directory at the same time. */
const buildLocks = new KeyedMutex()

interface PreviousBuild {
  readonly files: readonly string[]
}

/**
 * The previous build's manifest, if the directory holds one. Only a manifest
 * this builder wrote for this tenant counts: the files it lists are the ones the
 * next build may remove, so a file list written by anything else — another
 * tool, a hand-made file, a build of another tenant sharing the directory — is
 * refused rather than trusted.
 */
async function readPreviousBuild(outputDir: string, tenantId: string): Promise<PreviousBuild | undefined> {
  let text: string
  try {
    text = await readFile(path.join(outputDir, BUILD_MANIFEST_FILE), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    throw new StaticBuildError('BAD_MANIFEST', `${BUILD_MANIFEST_FILE} in ${outputDir} is not a Hyla build manifest.`, { cause: error })
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { readonly builder?: unknown; readonly tenantId?: unknown; readonly files?: unknown }
  if (record.builder !== 'hyla-mini' || typeof record.tenantId !== 'string' || !Array.isArray(record.files)) {
    throw new StaticBuildError('BAD_MANIFEST', `${BUILD_MANIFEST_FILE} in ${outputDir} is not a manifest this builder wrote (builder "hyla-mini", a tenant id and a file list); refusing to treat the directory as a previous build.`)
  }
  if (record.tenantId !== tenantId) {
    throw new StaticBuildError('BAD_MANIFEST', `${BUILD_MANIFEST_FILE} in ${outputDir} belongs to a build of tenant ${record.tenantId}, not ${tenantId}; refusing to remove another tenant's files.`)
  }
  const files = record.files.filter((item): item is string => typeof item === 'string')
  return { files }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface LockRecord {
  readonly pid: number
  readonly startedAt: string
}

interface LockView {
  readonly record: Partial<LockRecord>
  readonly stale: boolean
}

async function inspectLock(file: string): Promise<LockView | undefined> {
  let text: string
  let mtimeMs: number
  try {
    text = await readFile(file, 'utf8')
    mtimeMs = (await lstat(file)).mtimeMs
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record: { pid?: number; startedAt?: string } = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown }
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) record.pid = pid
      if (typeof startedAt === 'string') record.startedAt = startedAt
    }
  }
  catch {
    // An unreadable lock is judged by its age alone.
  }
  const started = record.startedAt === undefined ? Number.NaN : Date.parse(record.startedAt)
  const age = Date.now() - (Number.isNaN(started) ? mtimeMs : started)
  const stale = age > BUILD_LOCK_STALE_MS || (record.pid !== undefined && !processAlive(record.pid))
  return { record, stale }
}

/**
 * Takes `.hyla-build.lock` in `root` with an exclusive create. A lock whose
 * process is gone or which is older than `BUILD_LOCK_STALE_MS` is removed and
 * the create retried once; any other holder is `BUILD_LOCKED`. The returned
 * function releases the lock, but only if it is still ours.
 */
async function acquireDiskLock(root: string): Promise<() => Promise<void>> {
  const file = path.join(root, BUILD_LOCK_FILE)
  const own: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() }
  const release = async (): Promise<void> => {
    const current = await inspectLock(file).catch(() => undefined)
    if (current && current.record.pid === own.pid && current.record.startedAt === own.startedAt) await rm(file, { force: true })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(own)}\n`, 'utf8')
      }
      finally {
        await handle.close()
      }
      return release
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = await inspectLock(file)
    if (holder === undefined) continue // released between the create and the read: try again
    if (!holder.stale) {
      const who = holder.record.pid === undefined ? 'an unreadable lock' : `pid ${holder.record.pid} since ${holder.record.startedAt ?? 'an unknown time'}`
      throw new StaticBuildError('BUILD_LOCKED', `Static build outputDir ${root} is locked by ${who} (${BUILD_LOCK_FILE}); another build is running.`)
    }
    await rm(file, { force: true }) // left behind by a crashed build
  }
  throw new StaticBuildError('BUILD_LOCKED', `Static build outputDir ${root} is locked (${BUILD_LOCK_FILE}) and the lock could not be taken over.`)
}

interface RenderedPage {
  readonly path: string
  readonly kind: string
  readonly postIds: readonly string[]
}

interface Snapshot {
  readonly contentVersion: string
  readonly files: ReadonlyMap<string, string>
  readonly pages: readonly RenderedPage[]
  readonly attempts: number
}

/**
 * Renders the whole public site into memory between two reads of the content
 * version. Pages come from the shared page cache, whose keys carry the version
 * they were rendered from, so two equal reads mean every page belongs to that
 * version. A version that moved is rendered again, a few times.
 */
async function renderSnapshot(site: SiteContext): Promise<Snapshot> {
  let moved: { readonly before: string; readonly after: string } | undefined
  for (let attempt = 1; attempt <= BUILD_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await site.repository.contentVersion()
    const files = new Map<string, string>()
    const pages: RenderedPage[] = []
    const put = (relative: string, content: string, meta?: { kind: string; postIds: readonly string[] }): void => {
      files.set(relative, content)
      if (meta) pages.push({ path: relative, ...meta })
    }
    const posts = await site.listPosts(ANONYMOUS)
    const index = await site.renderIndex(ANONYMOUS)
    put('index.html', index.html, { kind: index.meta.kind, postIds: index.meta.postIds })
    for (const post of posts) {
      // The posts were listed once, after `before` was read: render them as listed
      // (cached under `before`, as the request path would) instead of fetching each
      // one again — on the filesystem backend a lookup is a scan of the tenant's files.
      const page = await site.renderPostPage(post, ANONYMOUS, before)
      if (!page) continue
      put(path.join('posts', post.slug, 'index.html'), page.html, { kind: page.meta.kind, postIds: page.meta.postIds })
    }
    const categories = [...new Set(posts.flatMap(post => post.categories))].sort()
    for (const category of categories) {
      const page = await site.renderIndex(ANONYMOUS, category)
      put(path.join('category', category, 'index.html'), page.html, { kind: page.meta.kind, postIds: page.meta.postIds })
    }
    put('site.json', JSON.stringify({
      tenantId: site.tenantId,
      title: site.site.title,
      defaultLocale: site.site.defaultLocale,
      configRevision: site.site.configRevision,
      posts: posts.map(post => ({ id: post.id, slug: post.slug, title: post.title, locale: post.locale, categories: post.categories, tags: post.tags })),
    }, null, 2))
    const after = await site.repository.contentVersion()
    if (after === before) return { contentVersion: after, files, pages, attempts: attempt }
    moved = { before, after }
  }
  throw new StaticBuildError('BUILD_CONTENT_CHANGED', `Static build of ${site.tenantId} gave up after ${BUILD_SNAPSHOT_ATTEMPTS} attempts: the content version kept moving while pages were rendered (last ${moved?.before} → ${moved?.after}). Nothing was written.`)
}

/**
 * Renders the public site to files with the same renderer and pipelines the
 * HTTP path uses. Only what an anonymous visitor may see is written; drafts,
 * private posts, credentials and internal references never reach the output.
 *
 * Publishing is ordered, not transactional (H03: per-file atomic replacement,
 * no multi-file ACID): the whole site is rendered into memory first, from one
 * content version; then every new file is atomically replaced, then files of
 * the previous build that no longer exist are removed, then the manifest is
 * written last. A build that fails before the write phase leaves the previous
 * build untouched. One build per directory at a time: an in-process mutex on
 * the resolved directory plus `.hyla-build.lock` on disk for other processes.
 * Nothing below the output directory may be a symbolic link; every path that
 * will be written or removed is checked before the first write.
 */
export const StaticBuilder = define.service('static-builder', {
  requires: { context: SiteContext, options: BuildOptions },
  async setup({ context, options }): Promise<StaticBuilder> {
    const site = await context.load()
    const settings = options.read()
    if (!isSafeOutputDir(settings.outputDir)) {
      throw new TypeError(`Static build outputDir must be an absolute path with at least two segments, received ${settings.outputDir}.`)
    }
    const declared = path.resolve(settings.outputDir)
    return {
      async build() {
        await mkdir(declared, { recursive: true })
        if ((await lstat(declared)).isSymbolicLink()) {
          throw new StaticBuildError('UNSAFE_OUTPUT_DIR', `Static build outputDir ${declared} is a symbolic link; refusing to write through it.`)
        }
        const root = await realpath(declared)
        if (!isSafeOutputDir(root)) {
          throw new StaticBuildError('UNSAFE_OUTPUT_DIR', `Static build outputDir ${declared} resolves to ${root}, which is not a safe output directory.`)
        }
        return buildLocks.withLock(root, async () => {
          const releaseLock = await acquireDiskLock(root)
          try {
            const inside = (relative: string): string => {
              const target = path.resolve(root, relative)
              if (!target.startsWith(root + path.sep)) throw new StaticBuildError('UNSAFE_OUTPUT_DIR', `Refusing to touch a path outside ${root}: ${relative}`)
              return target
            }
            const noSymlink = async (target: string): Promise<void> => {
              try {
                await assertNoSymlink(root, target)
              }
              catch (error) {
                if (error instanceof UnsafePathError) throw new StaticBuildError('UNSAFE_OUTPUT_DIR', `${error.message} (static build output ${root}; nothing was written)`, { cause: error })
                throw error
              }
            }
            const manifestFile = path.join(root, BUILD_MANIFEST_FILE)
            await noSymlink(manifestFile)
            // The directory must be empty or hold a previous build of this builder.
            // Only files listed in that build's manifest are removed — never anything
            // else that happens to live there — and only directories they left empty.
            const previous = await readPreviousBuild(root, site.tenantId)
            const foreign = (await readdir(root)).filter(entry => !BUILD_OWN_FILES.has(entry))
            if (previous === undefined && foreign.length > 0) {
              throw new StaticBuildError('OUTPUT_DIR_NOT_EMPTY', `Static build outputDir ${root} is not empty and holds no previous Hyla build (${BUILD_MANIFEST_FILE}); refusing to write into it.`)
            }

            const snapshot = await renderSnapshot(site)
            const written = new Map<string, string>()
            for (const relative of snapshot.files.keys()) written.set(relative, inside(relative))
            const stale = new Map<string, string>()
            for (const relative of previous?.files ?? []) {
              if (!snapshot.files.has(relative)) stale.set(relative, inside(relative))
            }
            // Every path this build will write or remove is checked before the first write.
            for (const target of [...written.values(), ...stale.values()]) await noSymlink(target)

            for (const [relative, content] of snapshot.files) await writeFileAtomic(written.get(relative) as string, content)
            const directories = new Set<string>()
            for (const target of stale.values()) {
              await rm(target, { force: true })
              let directory = path.dirname(target)
              while (directory.startsWith(root + path.sep)) {
                directories.add(directory)
                directory = path.dirname(directory)
              }
            }
            for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
              await rmdir(directory).catch(() => undefined) // only succeeds when the directory is empty
            }
            const files = [...snapshot.files.keys()].sort()
            await writeFileAtomic(manifestFile, `${JSON.stringify({
              builder: 'hyla-mini',
              tenantId: site.tenantId,
              configRevision: site.site.configRevision,
              contentVersion: snapshot.contentVersion,
              generatedAt: new Date().toISOString(),
              files,
            }, null, 2)}\n`)
            return {
              tenantId: site.tenantId,
              configRevision: site.site.configRevision,
              contentVersion: snapshot.contentVersion,
              outputDir: root,
              files,
              pages: snapshot.pages,
              attempts: snapshot.attempts,
            }
          }
          finally {
            await releaseLock()
          }
        })
      },
    }
  },
})

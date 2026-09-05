import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { define } from '../../syna.js'
import { ContentStoreContract } from '../../domain/content.js'
import type { ContentRepository, ContentStore } from '../../domain/content.js'
import {
  assertSafeSegment,
  comparePosts,
  isLocale,
  isPostStatus,
  isSafeSegment,
  matchesFilter,
  normalizeDomain,
  normalizePostInput,
} from '../../domain/model.js'
import type {
  Category,
  Post,
  PostFilter,
  PostInput,
  SiteConfig,
  SiteConfigInput,
  Tag,
} from '../../domain/model.js'
import { DomainConflictError, SlugConflictError, assertName, buildPost, normalizeTimestamp, resolveRevision } from '../common.js'
import { ContentRoot } from './config.js'
import {
  KeyedMutex,
  UnsafePathError,
  assertNoSymlink,
  readFrontMatter,
  readTextIfExists,
  relativePosix,
  safeJoin,
  writeFileAtomic,
  writeFrontMatter,
} from './files.js'
import { ContentLayoutChoice } from './layout.js'
import type { ContentLayout } from './layout.js'

const CATEGORIES_FILE = 'categories.json'
const TAGS_FILE = 'tags.json'
const SITE_FILE = 'site.json'
/** Per-tenant monotonic counter advanced by every mutation; read by page caches. */
const VERSION_FILE = 'content.version'

interface PostFile {
  readonly post: Post
  /** POSIX path relative to the tenant directory. */
  readonly relativePath: string
}

interface NamedEntry {
  readonly slug: string
  readonly name: string
}

type StoredSiteConfig = SiteConfigInput & { readonly configRevision: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, what: string, file: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new TypeError(`${file}: front matter ${what} must be a list of strings.`)
  }
  return value
}

/** Turns one Markdown file into a Post; the id in the front matter is the identity. */
export function parsePostFile(tenantId: string, file: string, text: string): Post {
  const { data, body } = readFrontMatter(text)
  const fail = (message: string): never => {
    throw new TypeError(`${file}: ${message}`)
  }
  const id = data['id']
  if (typeof id !== 'string' || id.trim().length === 0 || id.includes('/') || id.includes('..')) {
    return fail('front matter id must be a non-empty string without path separators.')
  }
  const slug = isSafeSegment(data['slug']) ? data['slug'] : fail('front matter slug is not a safe segment.')
  const locale = isLocale(data['locale']) ? data['locale'] : fail('front matter locale is unsupported.')
  const status = isPostStatus(data['status']) ? data['status'] : fail('front matter status is invalid.')
  const title = typeof data['title'] === 'string' ? data['title'] : fail('front matter title must be a string.')
  const categories = stringArray(data['categories'] ?? [], 'categories', file)
  const tags = stringArray(data['tags'] ?? [], 'tags', file)
  const primary = data['primaryCategory']
  const primaryCategory = primary === undefined || primary === null
    ? undefined
    : typeof primary === 'string' ? primary : fail('front matter primaryCategory must be a string.')
  const revision = data['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return fail('front matter revision must be a positive integer.')
  }
  const createdAt = typeof data['createdAt'] === 'string' ? data['createdAt'] : fail('front matter createdAt must be a string.')
  const updatedAt = typeof data['updatedAt'] === 'string' ? data['updatedAt'] : fail('front matter updatedAt must be a string.')
  const input = normalizePostInput(tenantId, {
    id, slug, locale, title, body, status, categories, tags,
    ...(primaryCategory !== undefined ? { primaryCategory } : {}),
  })
  return buildPost(tenantId, input, {
    revision,
    createdAt: normalizeTimestamp(createdAt, `${file}: createdAt`),
    updatedAt: normalizeTimestamp(updatedAt, `${file}: updatedAt`),
  })
}

export function serializePost(post: Post): string {
  return writeFrontMatter({
    id: post.id,
    slug: post.slug,
    locale: post.locale,
    title: post.title,
    status: post.status,
    categories: [...post.categories],
    primaryCategory: post.primaryCategory ?? null,
    tags: [...post.tags],
    revision: post.revision,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  }, post.body)
}

export function createFilesystemContentStore(rootDir: string, layout: ContentLayout): ContentStore {
  const root = path.resolve(rootDir)
  const locks = new KeyedMutex()

  const tenantDir = (tenantId: string): string => safeJoin(root, assertSafeSegment(tenantId, 'tenantId'))

  /** Absolute path of a tenant-relative file after the traversal and symlink checks. */
  async function resolveTenantFile(tenantId: string, relative: string): Promise<string> {
    const directory = tenantDir(tenantId)
    const target = safeJoin(directory, relative)
    await assertNoSymlink(root, target)
    return target
  }

  async function scanPosts(tenantId: string): Promise<PostFile[]> {
    const directory = tenantDir(tenantId)
    await assertNoSymlink(root, directory)
    const found: PostFile[] = []
    const visit = async (absoluteDir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true })
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const absolute = path.join(absoluteDir, entry.name)
        if (entry.isSymbolicLink()) {
          throw new UnsafePathError(`Refusing to read ${JSON.stringify(absolute)}: symbolic links are not allowed under the content root.`)
        }
        if (entry.isDirectory()) {
          if (layout.recursive) await visit(absolute)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const text = await readTextIfExists(absolute)
        if (text === undefined) continue
        const relativePath = relativePosix(directory, absolute)
        found.push({ post: parsePostFile(tenantId, absolute, text), relativePath })
      }
    }
    for (const postRoot of layout.postRoots) {
      await visit(safeJoin(directory, postRoot))
    }
    return found
  }

  async function readJson<T>(tenantId: string, file: string, guard: (value: unknown) => value is T): Promise<T | undefined> {
    const absolute = await resolveTenantFile(tenantId, file)
    const text = await readTextIfExists(absolute)
    if (text === undefined) return undefined
    const parsed: unknown = JSON.parse(text)
    if (!guard(parsed)) throw new TypeError(`${absolute}: unexpected JSON shape.`)
    return parsed
  }

  async function writeJson(tenantId: string, file: string, value: unknown): Promise<void> {
    const absolute = await resolveTenantFile(tenantId, file)
    await writeFileAtomic(absolute, `${JSON.stringify(value, null, 2)}\n`)
  }

  const isNamedList = (value: unknown): value is NamedEntry[] =>
    Array.isArray(value) && value.every(item => isRecord(item) && typeof item['slug'] === 'string' && typeof item['name'] === 'string')

  const isStoredSiteConfig = (value: unknown): value is StoredSiteConfig =>
    isRecord(value) && typeof value['configRevision'] === 'number' && typeof value['tenantId'] === 'string'

  async function upsertNamed(tenantId: string, file: string, entry: NamedEntry): Promise<void> {
    const current = (await readJson(tenantId, file, isNamedList)) ?? []
    const next = [...current.filter(item => item.slug !== entry.slug), entry]
      .sort((left, right) => left.slug.localeCompare(right.slug))
    await writeJson(tenantId, file, next)
  }

  /**
   * The repository implementation. `serialize` wraps every mutation in the
   * tenant lock for the public repository; the repository handed to
   * `transaction()` already runs inside that lock and passes the identity.
   */
  async function listTenantIds(): Promise<readonly string[]> {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isSafeSegment(entry.name))
      .map(entry => entry.name)
      .sort()
  }

  function repository(tenantId: string, serialize: <T>(fn: () => Promise<T>) => Promise<T>): ContentRepository {
    assertSafeSegment(tenantId, 'tenantId')

    const readVersion = async (): Promise<number> => {
      const text = await readTextIfExists(await resolveTenantFile(tenantId, VERSION_FILE))
      const parsed = text === undefined ? 0 : Number.parseInt(text, 10)
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
    }
    /** Called inside the tenant's serialized mutation section. */
    const bump = async (): Promise<void> => {
      const next = (await readVersion()) + 1
      await writeFileAtomic(await resolveTenantFile(tenantId, VERSION_FILE), `${next}\n`)
    }

    async function savePost(input: PostInput): Promise<Post> {
      const normalized = normalizePostInput(tenantId, input)
      const files = await scanPosts(tenantId)
      const holder = files.find(file => file.post.slug === normalized.slug && file.post.id !== normalized.id)
      if (holder !== undefined) throw new SlugConflictError(tenantId, normalized.slug, holder.post.id, normalized.id)
      const previous = files.find(file => file.post.id === normalized.id)
      const post = buildPost(tenantId, normalized, resolveRevision(normalized, previous?.post))

      const relativePath = layout.postPath(post)
      const target = await resolveTenantFile(tenantId, relativePath)
      await writeFileAtomic(target, serializePost(post))
      // Identity is the front-matter id: a slug or primary-category rename moves
      // the file. The new file is on disk before the old one goes away.
      if (previous !== undefined && previous.relativePath !== relativePath) {
        await rm(await resolveTenantFile(tenantId, previous.relativePath), { force: true })
      }
      return post
    }

    return {
      tenantId,
      async listPosts(filter: PostFilter) {
        const files = await scanPosts(tenantId)
        return files.map(file => file.post).filter(post => matchesFilter(post, filter)).sort(comparePosts)
      },
      async getPost(slug, filter) {
        const files = await scanPosts(tenantId)
        const post = files.find(file => file.post.slug === slug)?.post
        if (post === undefined) return undefined
        return matchesFilter(post, { visibility: filter.visibility }) ? post : undefined
      },
      async getPostById(id) {
        const files = await scanPosts(tenantId)
        return files.find(file => file.post.id === id)?.post
      },
      savePost: input => serialize(async () => {
        const post = await savePost(input)
        await bump()
        return post
      }),
      deletePost: id => serialize(async () => {
        const files = await scanPosts(tenantId)
        const existing = files.find(file => file.post.id === id)
        if (existing === undefined) return false
        await rm(await resolveTenantFile(tenantId, existing.relativePath), { force: true })
        await bump()
        return true
      }),
      async listCategories() {
        const entries = (await readJson(tenantId, CATEGORIES_FILE, isNamedList)) ?? []
        return entries.map((entry): Category => ({ tenantId, ...entry }))
      },
      saveCategory: category => serialize(async () => {
        const entry = { slug: assertSafeSegment(category.slug, 'Category slug'), name: assertName(category.name, 'Category name') }
        await upsertNamed(tenantId, CATEGORIES_FILE, entry)
        await bump()
        return { tenantId, ...entry }
      }),
      async listTags() {
        const entries = (await readJson(tenantId, TAGS_FILE, isNamedList)) ?? []
        return entries.map((entry): Tag => ({ tenantId, ...entry }))
      },
      saveTag: tag => serialize(async () => {
        const entry = { slug: assertSafeSegment(tag.slug, 'Tag slug'), name: assertName(tag.name, 'Tag name') }
        await upsertNamed(tenantId, TAGS_FILE, entry)
        await bump()
        return { tenantId, ...entry }
      }),
      async getSiteConfig() {
        const stored = await readJson(tenantId, SITE_FILE, isStoredSiteConfig)
        if (stored === undefined) return undefined
        return { ...stored, tenantId } satisfies SiteConfig
      },
      saveSiteConfig: config => serialize(async () => {
        if (config.tenantId !== tenantId) {
          throw new TypeError(`SiteConfig.tenantId ${JSON.stringify(config.tenantId)} does not match repository tenant ${tenantId}.`)
        }
        const claimed = new Set((Array.isArray(config.domains) ? config.domains : []).map(normalizeDomain).filter((host): host is string => host !== undefined))
        if (claimed.size > 0) {
          for (const other of await listTenantIds()) {
            if (other === tenantId) continue
            const theirs = await readJson(other, SITE_FILE, isStoredSiteConfig).catch(() => undefined)
            const taken = (Array.isArray(theirs?.domains) ? theirs.domains : []).find(domain => {
              const host = normalizeDomain(domain)
              return host !== undefined && claimed.has(host)
            })
            if (taken !== undefined) throw new DomainConflictError(tenantId, taken, other)
          }
        }
        const previous = await readJson(tenantId, SITE_FILE, isStoredSiteConfig)
        const next: StoredSiteConfig = { ...config, configRevision: (previous?.configRevision ?? 0) + 1 }
        await writeJson(tenantId, SITE_FILE, next)
        await bump()
        return next
      }),
      contentVersion: async () => String(await readVersion()),
    }
  }

  return {
    backend: 'filesystem',
    forTenant: tenantId => repository(tenantId, fn => locks.withLock(tenantId, fn)),
    listTenants: listTenantIds,
    /**
     * Unit of work on the filesystem backend: `work` runs while holding the
     * tenant's in-process lock, so mutations of one tenant are serialized within
     * this process and each file is replaced atomically (temp file + rename).
     * This is NOT multi-file ACID: a throw half-way leaves the files already
     * written, and other processes are not excluded.
     */
    async transaction(tenantId, work) {
      assertSafeSegment(tenantId, 'tenantId')
      return locks.withLock(tenantId, () => work(repository(tenantId, fn => fn())))
    },
    deleteTenant: tenantId => locks.withLock(tenantId, async () => {
      const directory = tenantDir(tenantId)
      // Re-validate: exactly one safe segment below the root, and not a symlink.
      const relative = path.relative(root, directory)
      if (relative !== tenantId || !isSafeSegment(relative) || path.dirname(directory) !== root) {
        throw new UnsafePathError(`Refusing to delete ${JSON.stringify(directory)}: not a tenant directory of ${root}.`)
      }
      let stats
      try {
        stats = await lstat(directory)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new UnsafePathError(`Refusing to delete ${JSON.stringify(directory)}: it is not a real directory.`)
      }
      await rm(directory, { recursive: true, force: true })
    }),
  }
}

export const FilesystemContentStore = define.service('filesystem-content-store', {
  metadata: { displayName: 'Filesystem content store' },
  provides: [ContentStoreContract],
  requires: { root: ContentRoot, layout: ContentLayoutChoice },
  async setup({ root, layout }): Promise<ContentStore> {
    const { rootDir } = root.read()
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
      throw new TypeError(`ContentRoot.rootDir must be an absolute path, received ${JSON.stringify(rootDir)}.`)
    }
    await mkdir(rootDir, { recursive: true })
    const chosenLayout = await layout.load()
    return createFilesystemContentStore(rootDir, chosenLayout)
  },
})

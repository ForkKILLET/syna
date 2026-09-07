import type { Post, PostFilter, SiteConfig } from '../domain/model.js'
import { ContentBackend, type ContentRepository } from '../domain/content.js'
import { Renderer, type RenderedPage } from '../render/renderer.js'
import { canViewPost, visibilityClass, type Principal } from '../auth/principal.js'
import { define } from '../syna.js'
import { DEFAULT_SITE_MANAGER_SETTINGS, SiteManagerOptions, SiteSnapshot, TenantId } from './inputs.js'

export interface PageCacheStats {
  readonly hits: number
  readonly misses: number
  /** Lookups that joined a render already in flight for the same key (single-flight). */
  readonly coalesced: number
  readonly entries: number
  readonly evictions: number
  readonly maxEntries: number
}

/**
 * One site's working context: tenantised repository, configuration snapshot
 * and a page cache whose key includes tenant, configuration revision, content
 * version, locale, visibility class and path. The content version comes from
 * the store on every lookup, so an edit or a visibility change is never served
 * stale; when it moves, the whole page cache of this site is dropped. It never
 * caches authorization decisions or the Syna plan; Syna's plan cache never
 * caches pages. The cache is bounded (`pageCacheMaxEntries`, least recently
 * used dropped), concurrent lookups of one key share one render, concurrent
 * version lookups share one store round-trip, and a render that fails is not
 * cached.
 */
export interface SiteContext {
  readonly tenantId: string
  readonly site: SiteConfig
  readonly repository: ContentRepository
  listPosts(principal: Principal, filter?: Omit<PostFilter, 'visibility'>): Promise<readonly Post[]>
  getPost(slug: string, principal: Principal): Promise<Post | undefined>
  renderIndex(principal: Principal, category?: string): Promise<RenderedPage>
  renderPost(slug: string, principal: Principal): Promise<RenderedPage | undefined>
  /**
   * Renders a post the caller already holds — a static build lists the posts
   * once instead of fetching each one again. `version` must be the content
   * version read before the post was listed: the page is cached under it, as
   * `renderPost` would, and is only kept while the cache is at that version. A
   * post of another tenant or one the principal may not see is refused.
   */
  renderPostPage(post: Post, principal: Principal, version: string): Promise<RenderedPage | undefined>
  renderNotFound(path: string): RenderedPage
  renderComment(markdown: string): Promise<string>
  readonly cacheStats: PageCacheStats
}

export const SiteContext = define.service('site-context', {
  requires: {
    tenant: TenantId,
    snapshot: SiteSnapshot,
    store: ContentBackend,
    renderer: Renderer,
    settings: SiteManagerOptions,
  },
  async setup({ tenant, snapshot, store, renderer, settings }): Promise<SiteContext> {
    const tenantId = tenant.read()
    const site = snapshot.read()
    if (site.tenantId !== tenantId) {
      throw new TypeError(`Site snapshot belongs to ${site.tenantId}, not ${tenantId}.`)
    }
    const maxEntries = settings.read().pageCacheMaxEntries ?? DEFAULT_SITE_MANAGER_SETTINGS.pageCacheMaxEntries
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(`pageCacheMaxEntries must be a positive integer; got ${String(maxEntries)}.`)
    }
    const repository = (await store.load()).forTenant(tenantId)
    const render = await renderer.load()
    const pages = new Map<string, RenderedPage>() // insertion order = recency
    const producing = new Map<string, Promise<RenderedPage>>()
    let hits = 0
    let misses = 0
    let coalesced = 0
    let evictions = 0
    let cachedVersion: string | undefined
    let versionRead: Promise<string> | undefined

    /**
     * The content version must be read BEFORE any content that ends up in the
     * page. A page cached under version v was then rendered from content read
     * after the store reported v; any edit after that moves the version past
     * v, so an entry can be served stale only if content is read first and the
     * version afterwards (the edit would then land under the newer key).
     * Concurrent lookups share one store round-trip; the order above holds for
     * each of them, since none reads content before the shared read settles.
     */
    const currentVersion = (): Promise<string> => {
      versionRead ??= (async () => {
        const version = await repository.contentVersion()
        if (version !== cachedVersion) {
          pages.clear()
          cachedVersion = version
        }
        return version
      })().finally(() => { versionRead = undefined })
      return versionRead
    }

    const cached = (version: string, principal: Principal, path: string, produce: () => Promise<RenderedPage>): Promise<RenderedPage> => {
      const key = `${tenantId}|${site.configRevision}|${version}|${site.defaultLocale}|${visibilityClass(principal, tenantId)}|${path}`
      const existing = pages.get(key)
      if (existing) {
        hits += 1
        pages.delete(key)
        pages.set(key, existing) // most recently used
        return Promise.resolve(existing)
      }
      const inFlight = producing.get(key)
      if (inFlight) {
        coalesced += 1
        return inFlight
      }
      misses += 1
      const pending = produce().then(page => {
        // A render under a version the cache has already left behind is returned but not kept.
        if (cachedVersion === version) {
          pages.set(key, page)
          if (pages.size > maxEntries) {
            const oldest = pages.keys().next().value
            if (oldest !== undefined) {
              pages.delete(oldest)
              evictions += 1
            }
          }
        }
        return page
      }).finally(() => { producing.delete(key) })
      producing.set(key, pending)
      return pending
    }

    const visible = async (principal: Principal, filter: Omit<PostFilter, 'visibility'> = {}) => {
      const posts = await repository.listPosts({ ...filter, visibility: 'all' })
      return posts.filter(post => canViewPost(principal, tenantId, post))
    }

    return {
      tenantId,
      site,
      repository,
      listPosts: visible,
      async getPost(slug, principal) {
        const post = await repository.getPost(slug, { visibility: 'all' })
        return post && canViewPost(principal, tenantId, post) ? post : undefined
      },
      async renderIndex(principal, category) {
        const version = await currentVersion()
        return cached(version, principal, category ? `/category/${category}` : '/', async () => {
          const posts = await visible(principal, category ? { category } : {})
          return render.renderIndexPage(site, posts, category ? { category } : {})
        })
      },
      async renderPost(slug, principal) {
        const version = await currentVersion()
        const post = await repository.getPost(slug, { visibility: 'all' })
        if (!post || !canViewPost(principal, tenantId, post)) return undefined
        return cached(version, principal, `/posts/${slug}`, () => render.renderPostPage(site, post))
      },
      async renderPostPage(post, principal, version) {
        if (post.tenantId !== tenantId || !canViewPost(principal, tenantId, post)) return undefined
        return cached(version, principal, `/posts/${post.slug}`, () => render.renderPostPage(site, post))
      },
      renderNotFound: path => render.renderNotFound(site, path),
      renderComment: markdown => render.renderComment(site, markdown),
      cacheStats: {
        get hits() { return hits },
        get misses() { return misses },
        get coalesced() { return coalesced },
        get entries() { return pages.size },
        get evictions() { return evictions },
        get maxEntries() { return maxEntries },
      },
    }
  },
})

import type { Post, PostFilter, SiteConfig } from '../domain/model.js'
import { ContentBackend, type ContentRepository } from '../domain/content.js'
import { Renderer, type RenderedPage } from '../render/renderer.js'
import { canViewPost, visibilityClass, type Principal } from '../auth/principal.js'
import { define } from '../syna.js'
import { SiteSnapshot, TenantId } from './inputs.js'

export interface PageCacheStats {
  readonly hits: number
  readonly misses: number
  readonly entries: number
}

/**
 * One site's working context: tenantised repository, configuration snapshot
 * and a page cache whose key includes tenant, configuration revision, content
 * version, locale, visibility class and path. The content version comes from
 * the store on every lookup, so an edit or a visibility change is never served
 * stale; when it moves, the whole page cache of this site is dropped. It never
 * caches authorization decisions or the Syna plan; Syna's plan cache never
 * caches pages.
 */
export interface SiteContext {
  readonly tenantId: string
  readonly site: SiteConfig
  readonly repository: ContentRepository
  listPosts(principal: Principal, filter?: Omit<PostFilter, 'visibility'>): Promise<readonly Post[]>
  getPost(slug: string, principal: Principal): Promise<Post | undefined>
  renderIndex(principal: Principal, category?: string): Promise<RenderedPage>
  renderPost(slug: string, principal: Principal): Promise<RenderedPage | undefined>
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
  },
  async setup({ tenant, snapshot, store, renderer }): Promise<SiteContext> {
    const tenantId = tenant.read()
    const site = snapshot.read()
    if (site.tenantId !== tenantId) {
      throw new TypeError(`Site snapshot belongs to ${site.tenantId}, not ${tenantId}.`)
    }
    const repository = (await store.load()).forTenant(tenantId)
    const render = await renderer.load()
    const pages = new Map<string, RenderedPage>()
    let hits = 0
    let misses = 0
    let cachedVersion: string | undefined

    /**
     * The content version must be read BEFORE any content that ends up in the
     * page. A page cached under version v was then rendered from content read
     * after the store reported v; any edit after that moves the version past
     * v, so an entry can be served stale only if content is read first and the
     * version afterwards (the edit would then land under the newer key).
     */
    const currentVersion = async (): Promise<string> => {
      const version = await repository.contentVersion()
      if (version !== cachedVersion) {
        pages.clear()
        cachedVersion = version
      }
      return version
    }

    const cached = async (version: string, principal: Principal, path: string, produce: () => Promise<RenderedPage>): Promise<RenderedPage> => {
      const key = `${tenantId}|${site.configRevision}|${version}|${site.defaultLocale}|${visibilityClass(principal, tenantId)}|${path}`
      const existing = pages.get(key)
      if (existing) {
        hits += 1
        return existing
      }
      misses += 1
      const page = await produce()
      pages.set(key, page)
      return page
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
      renderNotFound: path => render.renderNotFound(site, path),
      renderComment: markdown => render.renderComment(site, markdown),
      cacheStats: {
        get hits() { return hits },
        get misses() { return misses },
        get entries() { return pages.size },
      },
    }
  },
})

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
 * and a page cache whose key includes tenant, configuration revision, locale,
 * visibility class and path. It never caches authorization decisions or the
 * Syna plan; Syna's plan cache never caches pages.
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

    const cached = async (principal: Principal, path: string, produce: () => Promise<RenderedPage>): Promise<RenderedPage> => {
      const key = `${tenantId}|${site.configRevision}|${site.defaultLocale}|${visibilityClass(principal, tenantId)}|${path}`
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
      renderIndex: (principal, category) => cached(principal, category ? `/category/${category}` : '/', async () => {
        const posts = await visible(principal, category ? { category } : {})
        return render.renderIndexPage(site, posts, category ? { category } : {})
      }),
      async renderPost(slug, principal) {
        const post = await repository.getPost(slug, { visibility: 'all' })
        if (!post || !canViewPost(principal, tenantId, post)) return undefined
        return cached(principal, `/posts/${slug}`, () => render.renderPostPage(site, post))
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

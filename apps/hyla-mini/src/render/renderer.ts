import type { Post, SiteConfig } from '../domain/model.js'
import { isCssColor, isSafeHref } from '../domain/site-config.js'
import { define } from '../syna.js'
import { PipelineBuilder, type BuiltPipeline } from './pipeline.js'

/** Used when a stored configuration (validated on save, but possibly older or foreign) carries an accent that is not a color. */
export const DEFAULT_ACCENT = '#000000'

export interface RenderedPage {
  readonly html: string
  /** Stable, comparable summary of what was rendered (no timestamps, no ids beyond post ids). */
  readonly meta: {
    readonly tenantId: string
    readonly title: string
    readonly locale: string
    readonly kind: 'index' | 'post' | 'category' | 'not-found'
    readonly postIds: readonly string[]
    readonly configRevision: number
  }
}

export interface PostView extends Post {
  readonly bodyHtml: string
  readonly previewHtml: string
}

/**
 * Renderer: HTML pages from posts and a site configuration. It depends only on
 * the PipelineBuilder (render infrastructure). Site and request facts are
 * arguments, so the same renderer serves HTTP and static builds unchanged.
 */
export interface Renderer {
  pipelinesFor(site: SiteConfig): Promise<{ body: BuiltPipeline; comment: BuiltPipeline; preview: BuiltPipeline }>
  renderPostView(site: SiteConfig, post: Post): Promise<PostView>
  renderPostPage(site: SiteConfig, post: Post): Promise<RenderedPage>
  renderIndexPage(site: SiteConfig, posts: readonly Post[], options?: { readonly category?: string }): Promise<RenderedPage>
  renderNotFound(site: SiteConfig, path: string): RenderedPage
  renderComment(site: SiteConfig, markdown: string): Promise<string>
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function layout(site: SiteConfig, locale: string, title: string, main: string): string {
  // Defence in depth behind the store's validation: an unsafe href renders as a
  // dead link, an accent that is not a color renders as the default.
  const navigation = site.navigation
    .map(item => `<li><a href="${escapeHtml(isSafeHref(item.href) ? item.href : '#')}">${escapeHtml(item.label)}</a></li>`)
    .join('')
  const accent = isCssColor(site.theme.accent) ? site.theme.accent : DEFAULT_ACCENT
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(locale)}" data-theme="${escapeHtml(site.theme.name)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} · ${escapeHtml(site.title)}</title>`,
    `<style>:root{--accent:${escapeHtml(accent)}}body{font-family:system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem}a{color:var(--accent)}</style>`,
    '</head>',
    '<body>',
    `<header><h1><a href="/">${escapeHtml(site.title)}</a></h1><nav><ul>${navigation}</ul></nav></header>`,
    `<main>${main}</main>`,
    `<footer><small>${escapeHtml(site.title)} · theme ${escapeHtml(site.theme.name)}</small></footer>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export const Renderer = define.service('renderer', {
  requires: { pipelines: PipelineBuilder },
  async setup({ pipelines }): Promise<Renderer> {
    const builder = await pipelines.load()

    // Bodies and previews come from the site's authors (trusted); comments are
    // foreign input and get the untrusted policy on top of the site's recipe.
    const pipelinesFor = async (site: SiteConfig) => {
      const [body, comment, preview] = await Promise.all([
        builder.build(site.recipes.body),
        builder.build(site.recipes.comment, { trust: 'untrusted' }),
        builder.build(site.recipes.preview),
      ])
      return { body, comment, preview }
    }

    const renderPostView = async (site: SiteConfig, post: Post): Promise<PostView> => {
      const built = await pipelinesFor(site)
      const [bodyHtml, previewHtml] = await Promise.all([built.body.process(post.body), built.preview.process(post.body)])
      return { ...post, bodyHtml, previewHtml }
    }

    return {
      pipelinesFor,
      renderPostView,
      async renderPostPage(site, post) {
        const view = await renderPostView(site, post)
        const categories = post.categories.map(slug => `<a href="/category/${escapeHtml(slug)}">${escapeHtml(slug)}</a>`).join(', ')
        const tags = post.tags.map(slug => `<span class="tag">${escapeHtml(slug)}</span>`).join(' ')
        const main = [
          `<article data-post-id="${escapeHtml(post.id)}" data-status="${escapeHtml(post.status)}">`,
          `<h2>${escapeHtml(post.title)}</h2>`,
          `<p class="meta"><time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(post.createdAt.slice(0, 10))}</time> · ${categories} · ${tags}</p>`,
          `<div class="body">${view.bodyHtml}</div>`,
          '</article>',
        ].join('\n')
        return {
          html: layout(site, post.locale, post.title, main),
          meta: { tenantId: site.tenantId, title: post.title, locale: post.locale, kind: 'post', postIds: [post.id], configRevision: site.configRevision },
        }
      },
      async renderIndexPage(site, posts, options = {}) {
        const built = await pipelinesFor(site)
        const items = await Promise.all(posts.map(async post => {
          const preview = await built.preview.process(post.body)
          return [
            `<li data-post-id="${escapeHtml(post.id)}">`,
            `<h2><a href="/posts/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>`,
            `<div class="preview">${preview}</div>`,
            '</li>',
          ].join('')
        }))
        const title = options.category ? `Category ${options.category}` : 'Home'
        const main = `<ul class="posts">${items.join('\n')}</ul>`
        return {
          html: layout(site, site.defaultLocale, title, main),
          meta: { tenantId: site.tenantId, title, locale: site.defaultLocale, kind: options.category ? 'category' : 'index', postIds: posts.map(post => post.id), configRevision: site.configRevision },
        }
      },
      renderNotFound(site, path) {
        return {
          html: layout(site, site.defaultLocale, 'Not found', `<p>No page at <code>${escapeHtml(path)}</code>.</p>`),
          meta: { tenantId: site.tenantId, title: 'Not found', locale: site.defaultLocale, kind: 'not-found', postIds: [], configRevision: site.configRevision },
        }
      },
      async renderComment(site, markdown) {
        const built = await pipelinesFor(site)
        return built.comment.process(markdown)
      },
    }
  },
})

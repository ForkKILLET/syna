import { define } from '../syna.js'
import { SiteContext } from './context.js'
import { CurrentRequest } from './inputs.js'

export interface HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** Comparable rendering summary when a page was rendered. */
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface RequestHandler {
  handle(): Promise<HttpResponse>
}

const html = (status: number, body: string, meta?: Readonly<Record<string, unknown>>): HttpResponse => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  body,
  ...(meta ? { meta } : {}),
})

/**
 * Request-local handler. It is the only request-scoped Service: everything it
 * needs (site context, renderer, store) is inherited from the SiteEnv/AppEnv,
 * which keeps the RequestEntry inside its fork budget.
 */
export const RequestHandler = define.service('request-handler', {
  requires: { request: CurrentRequest, context: SiteContext },
  async setup({ request, context }): Promise<RequestHandler> {
    const facts = request.read()
    const site = await context.load()
    return {
      async handle() {
        const { path, principal, method } = facts
        if (method !== 'GET' && method !== 'HEAD') {
          return { status: 405, headers: { allow: 'GET, HEAD' }, body: 'Method not allowed' }
        }
        if (path === '/' || path === '') {
          const page = await site.renderIndex(principal)
          return html(200, page.html, page.meta)
        }
        const category = /^\/category\/([a-z0-9-]+)$/.exec(path)
        if (category) {
          const page = await site.renderIndex(principal, category[1]!)
          return html(200, page.html, page.meta)
        }
        const post = /^\/posts\/([a-z0-9-]+)$/.exec(path)
        if (post) {
          const page = await site.renderPost(post[1]!, principal)
          if (page) return html(200, page.html, page.meta)
          const notFound = site.renderNotFound(path)
          return html(404, notFound.html, notFound.meta)
        }
        if (path === '/comments/preview') {
          const text = facts.query.text ?? ''
          const fragment = await site.renderComment(text)
          return html(200, fragment, { kind: 'comment-preview', tenantId: site.tenantId })
        }
        if (path === '/site.json') {
          return {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ tenantId: site.tenantId, title: site.site.title, defaultLocale: site.site.defaultLocale, configRevision: site.site.configRevision }),
          }
        }
        const notFound = site.renderNotFound(path)
        return html(404, notFound.html, notFound.meta)
      },
    }
  },
})

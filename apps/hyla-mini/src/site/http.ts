import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { EnvHandle } from '@syna/core'
import type { RequestHeaders } from '../auth/principal.js'
import type { DomainTable } from './domains.js'
import { requestHost } from './domains.js'
import type { AppEntry } from './app-entry.js'
import { RequestEntry } from './entries.js'
import type { RequestFacts } from './inputs.js'
import type { SiteEnvironmentManager } from './manager.js'

export interface HttpServerOptions {
  readonly app: EnvHandle<typeof AppEntry['requires']>
  readonly domains: DomainTable
  /** Honour X-Forwarded-Host. Only enable behind a proxy you control. */
  readonly trustProxy?: boolean
}

export interface RunningServer {
  readonly server: Server
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

function lowerHeaders(request: IncomingMessage): RequestHeaders {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ')
  }
  return headers
}

async function listen(server: Server, port: number): Promise<RunningServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as AddressInfo
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

/**
 * Dynamic side of the matrix: host → tenant → leased SiteEnv → RequestEntry.
 * Unknown hosts never reach tenant data; the lease is released after the
 * request world is disposed.
 */
export async function startHttpServer(options: HttpServerOptions, port = 0): Promise<RunningServer> {
  const manager: SiteEnvironmentManager = await options.app.deps.sites.load()
  const trustProxy = options.trustProxy ?? false

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const headers = lowerHeaders(request)
    const host = requestHost(headers, trustProxy)
    const tenantId = host ? options.domains.resolve(host) : undefined
    if (!host || !tenantId) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`Unknown host ${host ?? '(missing)'}`)
      return
    }
    const url = new URL(request.url ?? '/', `http://${host}`)
    let lease
    try {
      lease = await manager.acquire(tenantId, 'request')
    }
    catch (error) {
      const code = (error as { code?: string }).code
      const status = code === 'SITE_CAPACITY' ? 503 : code === 'SITE_MANAGER_CLOSED' ? 503 : code === 'UNKNOWN_TENANT' ? 404 : 500
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
      response.end(`${code ?? 'ERROR'}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    try {
      const authenticator = await lease.env.deps.auth.load()
      const principal = await authenticator.authenticate(headers)
      const facts: RequestFacts = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        host,
        headers,
        principal,
        target: 'http',
      }
      const result = await lease.env.run(RequestEntry, { request: facts }, async ({ handler }) => (await handler.load()).handle())
      response.writeHead(result.status, {
        ...result.headers,
        'x-hyla-tenant': tenantId,
        'x-hyla-config-revision': String(lease.configRevision),
      })
      response.end(request.method === 'HEAD' ? undefined : result.body)
    }
    catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`Internal error: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      lease.release()
    }
  }

  const server = createServer((request, response) => { void handle(request, response) })
  return listen(server, port)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** Serves a static build directory so the static side of the matrix can be read back over HTTP. */
export async function startStaticServer(rootDir: string, port = 0): Promise<RunningServer> {
  const root = path.resolve(rootDir)
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://static')
      let relative = decodeURIComponent(url.pathname)
      if (relative.endsWith('/')) relative += 'index.html'
      const target = path.resolve(root, `.${relative}`)
      if (!target.startsWith(root + path.sep) && target !== root) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      try {
        let file = target
        const info = await stat(file).catch(() => undefined)
        if (info?.isDirectory()) file = path.join(file, 'index.html')
        const content = await readFile(file)
        response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
        response.end(content)
      }
      catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
      }
    })()
  })
  return listen(server, port)
}

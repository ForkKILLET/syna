import type { ContentStore } from '../domain/content.js'
import type { RequestHeaders } from '../auth/principal.js'

/**
 * Controlled domain table: host → tenantId. Unknown hosts are refused before any
 * tenant data is touched. Forwarded host headers are honoured only when the
 * deployment declares that it sits behind a trusted proxy.
 */
export interface DomainTable {
  resolve(host: string): string | undefined
  readonly size: number
  refresh(): Promise<void>
}

export function normalizeHost(value: string | undefined): string | undefined {
  if (!value) return undefined
  const host = value.trim().toLowerCase().replace(/:\d+$/, '')
  return /^[a-z0-9.-]+$/.test(host) ? host : undefined
}

export function requestHost(headers: RequestHeaders, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-host']
    if (forwarded) return normalizeHost(forwarded.split(',')[0])
  }
  return normalizeHost(headers.host)
}

export async function loadDomainTable(store: ContentStore): Promise<DomainTable> {
  let table = new Map<string, string>()
  const refresh = async (): Promise<void> => {
    const next = new Map<string, string>()
    for (const tenantId of await store.listTenants()) {
      const config = await store.forTenant(tenantId).getSiteConfig()
      if (!config) continue
      for (const domain of config.domains) {
        const host = normalizeHost(domain)
        if (!host) continue
        const existing = next.get(host)
        if (existing && existing !== tenantId) {
          throw new Error(`Domain ${host} is claimed by both ${existing} and ${tenantId}.`)
        }
        next.set(host, tenantId)
      }
    }
    table = next
  }
  await refresh()
  return {
    resolve: host => table.get(host),
    get size() { return table.size },
    refresh,
  }
}

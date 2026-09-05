import type { ContentStore } from '../domain/content.js'
import type { RequestHeaders } from '../auth/principal.js'
import { normalizeDomain } from '../domain/model.js'

export interface DomainConflict {
  readonly host: string
  readonly tenants: readonly string[]
}

/**
 * Controlled domain table: host → tenantId. Unknown hosts are refused before any
 * tenant data is touched. Forwarded host headers are honoured only when the
 * deployment declares that it sits behind a trusted proxy.
 *
 * Stores reject a configuration that claims another tenant's domain
 * (`DomainConflictError`), so conflicts can only come from out-of-band edits.
 * A conflicted host is then served to nobody — refusing both claimants is the
 * only outcome that cannot hand one tenant's traffic to another — while every
 * other tenant keeps working; `conflicts` lists them for the operator.
 */
export interface DomainTable {
  resolve(host: string): string | undefined
  readonly size: number
  readonly conflicts: readonly DomainConflict[]
  refresh(): Promise<void>
}

export const normalizeHost = normalizeDomain

export function requestHost(headers: RequestHeaders, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-host']
    if (forwarded) return normalizeHost(forwarded.split(',')[0])
  }
  return normalizeHost(headers.host)
}

export async function loadDomainTable(store: ContentStore): Promise<DomainTable> {
  let table = new Map<string, string>()
  let conflicts: DomainConflict[] = []
  const refresh = async (): Promise<void> => {
    const claims = new Map<string, Set<string>>()
    for (const tenantId of await store.listTenants()) {
      const config = await store.forTenant(tenantId).getSiteConfig()
      if (!config) continue
      for (const domain of config.domains) {
        const host = normalizeHost(domain)
        if (!host) continue
        const owners = claims.get(host) ?? new Set<string>()
        owners.add(tenantId)
        claims.set(host, owners)
      }
    }
    const next = new Map<string, string>()
    const nextConflicts: DomainConflict[] = []
    for (const [host, owners] of claims) {
      if (owners.size === 1) next.set(host, [...owners][0]!)
      else nextConflicts.push({ host, tenants: [...owners].sort() })
    }
    table = next
    conflicts = nextConflicts.sort((left, right) => left.host.localeCompare(right.host))
  }
  await refresh()
  return {
    resolve: host => table.get(host),
    get size() { return table.size },
    get conflicts() { return conflicts },
    refresh,
  }
}

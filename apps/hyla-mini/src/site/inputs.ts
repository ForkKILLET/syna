import { define } from '../syna.js'
import type { SiteConfig } from '../domain/model.js'
import type { Principal, RequestHeaders } from '../auth/principal.js'

export const TenantId = define.input<string>('tenant-id', { metadata: { displayName: 'Tenant id' } })

/** The site configuration a SiteEnv was created for. Its configRevision is part of the working-set key. */
export const SiteSnapshot = define.input<SiteConfig>('site-snapshot', { metadata: { displayName: 'Site configuration snapshot' } })

export interface RequestFacts {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly host: string
  readonly headers: RequestHeaders
  /** Established by the site's Authenticator before the request world is entered. */
  readonly principal: Principal
  /** 'http' for live requests, 'static' while a static build renders pages. */
  readonly target: 'http' | 'static'
}

export const CurrentRequest = define.input<RequestFacts>('current-request', { metadata: { displayName: 'Current request' } })

export interface BuildSettings {
  /** Absolute output directory; created if missing, must be empty or a previous build. */
  readonly outputDir: string
}

export const BuildOptions = define.input<BuildSettings>('build-options')

export interface SiteManagerSettings {
  /** Maximum number of SiteEnvs (any state) the manager keeps. */
  readonly capacity: number
  /** Idle SiteEnvs (no lease) older than this are evicted by the sweeper. */
  readonly idleTtlMs: number
  readonly sweepIntervalMs: number
  /** Bounded queue for acquirers waiting for capacity; beyond it, acquire() rejects. */
  readonly maxPendingAcquires: number
  readonly acquireTimeoutMs: number
  /** Cold-creation failure backoff (bounded exponential). */
  readonly creationBackoffMs: number
  readonly creationBackoffMaxMs: number
  readonly shutdownTimeoutMs: number
  /**
   * Receives the failure when closing a SiteEnv rejects (a Service cleanup
   * threw, or a setup attempt ignored the stop signal past the disposal grace
   * and is reported as `UNSETTLED_ATTEMPT`). The record is already released
   * and its capacity handed on; the failure is counted in `stats().disposalFailures`.
   * Defaults to `console.error`.
   */
  readonly onDisposalError: (error: unknown, record: SiteRecordSummary) => void
}

export interface SiteRecordSummary {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
}

export const SiteManagerOptions = define.input<Partial<SiteManagerSettings>>('site-manager-options')

export const DEFAULT_SITE_MANAGER_SETTINGS: SiteManagerSettings = Object.freeze({
  capacity: 8,
  idleTtlMs: 30_000,
  sweepIntervalMs: 1_000,
  maxPendingAcquires: 64,
  acquireTimeoutMs: 5_000,
  creationBackoffMs: 200,
  creationBackoffMaxMs: 10_000,
  shutdownTimeoutMs: 5_000,
  onDisposalError: (error: unknown, record: SiteRecordSummary) => { console.error(`[hyla-mini sites] closing ${record.key} failed:`, error) },
})

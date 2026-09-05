import type { EnvHandle } from '@syna/core'
import { define } from '../syna.js'
import { ContentBackend } from '../domain/content.js'
import type { SiteConfig } from '../domain/model.js'
import { SiteAuth } from '../auth/contract.js'
import { SiteEntry } from './entries.js'
import { DEFAULT_SITE_MANAGER_SETTINGS, SiteManagerOptions, type SiteManagerSettings } from './inputs.js'
import type { SiteContext } from './context.js'

export type LeasePurpose = 'request' | 'build' | 'background'

export interface SiteLease {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  readonly env: EnvHandle<typeof SiteEntry['requires']>
  readonly context: SiteContext
  /** Idempotent. */
  release(): void
}

export interface SiteRecordView {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  readonly state: 'creating' | 'active' | 'draining' | 'disposed'
  readonly leases: number
  readonly idleForMs: number | undefined
}

export interface SiteManagerStats {
  readonly capacity: number
  readonly records: number
  readonly active: number
  readonly idle: number
  readonly creating: number
  readonly draining: number
  readonly leases: number
  readonly pendingAcquires: number
  readonly evictions: number
  readonly creations: number
  readonly creationFailures: number
  readonly rejectedForCapacity: number
  readonly closed: boolean
}

export class SiteCapacityError extends Error {
  readonly code = 'SITE_CAPACITY'
  constructor(message: string) {
    super(message)
    this.name = 'SiteCapacityError'
  }
}

export class SiteManagerClosedError extends Error {
  readonly code = 'SITE_MANAGER_CLOSED'
  constructor() {
    super('The site environment manager is shutting down; no new site environments are acquired.')
    this.name = 'SiteManagerClosedError'
  }
}

export class UnknownTenantError extends Error {
  readonly code = 'UNKNOWN_TENANT'
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} has no site configuration.`)
    this.name = 'UnknownTenantError'
  }
}

export interface SiteEnvironmentManager {
  /** Loads the tenant's current configuration and returns a lease on the matching SiteEnv (single-flight per key). */
  acquire(tenantId: string, purpose: LeasePurpose): Promise<SiteLease>
  /** Marks every environment of a tenant as stale; new acquires read the store again. Draining envs close when their leases end. */
  invalidate(tenantId: string): void
  /** Forces the idle sweep now (tests). */
  sweep(): Promise<number>
  records(): readonly SiteRecordView[]
  stats(): SiteManagerStats
  readonly settings: SiteManagerSettings
  /** Refuses new acquires, waits for leases up to the shutdown timeout, disposes every SiteEnv. Reports leases still held. */
  shutdown(): Promise<{ readonly unreleasedLeases: readonly string[] }>
}

interface SiteRecord {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  state: 'creating' | 'active' | 'draining' | 'disposed'
  leases: number
  lastReleasedAt: number
  env?: EnvHandle<typeof SiteEntry['requires']>
  context?: SiteContext
  creation?: Promise<void>
  disposal?: Promise<void>
}

interface Waiter {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

function runtimeIdentity(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
}

/**
 * SiteEnvs are a bounded working set, not tenant existence. Business facts
 * (posts, recipes, configuration versions) live in the content store; a
 * SiteEnv is only a cached, leased composition of them for one configuration
 * revision. Eviction therefore never loses data, and stale configuration is
 * handled by version rotation, never by evicting live tenants.
 */
export const SiteEnvironmentManager = define.service('site-environment-manager', {
  requires: { sites: SiteEntry, store: ContentBackend, options: SiteManagerOptions },
  async setup({ sites, store, options }, { onDispose, signal }): Promise<SiteEnvironmentManager> {
    const settings: SiteManagerSettings = Object.freeze({ ...DEFAULT_SITE_MANAGER_SETTINGS, ...options.read() })
    const boundSites = await sites.load()
    const contentStore = await store.load()
    const runtimeId = runtimeIdentity()

    const records = new Map<string, SiteRecord>()
    const waiters: Waiter[] = []
    /** Capacity granted to acquirers that have not inserted their record yet. */
    let reservations = 0
    const failureBackoff = new Map<string, { count: number; until: number; error: unknown }>()
    let closed = false
    let evictions = 0
    let creations = 0
    let creationFailures = 0
    let rejectedForCapacity = 0

    const keyFor = (tenantId: string, configRevision: number): string => `${runtimeId}|${tenantId}|${configRevision}`

    const readConfig = async (tenantId: string): Promise<SiteConfig> => {
      const config = await contentStore.forTenant(tenantId).getSiteConfig()
      if (!config) throw new UnknownTenantError(tenantId)
      return config
    }

    const liveRecords = (): SiteRecord[] => [...records.values()].filter(record => record.state !== 'disposed')
    const capacityUsed = (): number => liveRecords().length + reservations

    /** Hands one freed unit of capacity to the longest-waiting acquirer, as a reservation it already owns when it wakes. */
    const grantWaiter = (): void => {
      if (waiters.length === 0 || capacityUsed() >= settings.capacity) return
      const waiter = waiters.shift()!
      clearTimeout(waiter.timer)
      reservations += 1
      waiter.resolve()
    }

    const disposeRecord = (record: SiteRecord): Promise<void> => {
      if (record.disposal) return record.disposal
      record.state = 'disposed'
      records.delete(record.key)
      record.disposal = (async () => {
        try { await record.env?.dispose() }
        finally { grantWaiter() }
      })()
      return record.disposal
    }

    /** Evicts the longest-idle active record without leases. Never evicts a leased record. */
    const evictIdle = async (): Promise<boolean> => {
      const candidates = liveRecords()
        .filter(record => record.state === 'active' && record.leases === 0)
        .sort((left, right) => left.lastReleasedAt - right.lastReleasedAt)
      const victim = candidates[0]
      if (!victim) return false
      evictions += 1
      records.delete(victim.key)
      victim.state = 'disposed'
      victim.disposal = (async () => { await victim.env?.dispose() })()
      await victim.disposal
      return true
    }

    const waitForCapacity = (): Promise<void> => {
      if (waiters.length >= settings.maxPendingAcquires) {
        rejectedForCapacity += 1
        return Promise.reject(new SiteCapacityError(
          `All ${settings.capacity} site environments are leased and ${waiters.length} acquirers are already waiting.`,
        ))
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            rejectedForCapacity += 1
            reject(new SiteCapacityError(`Timed out after ${settings.acquireTimeoutMs} ms waiting for a site environment.`))
          }, settings.acquireTimeoutMs),
        }
        waiters.push(waiter)
      })
    }

    /** Returns holding one reservation. */
    const reserveCapacity = async (): Promise<void> => {
      while (capacityUsed() >= settings.capacity) {
        if (await evictIdle()) continue
        await waitForCapacity() // resolved with a reservation already granted to this acquirer
        if (closed) { reservations -= 1; throw new SiteManagerClosedError() }
        return
      }
      reservations += 1
    }

    const create = (record: SiteRecord, config: SiteConfig): Promise<void> => {
      record.creation = (async () => {
        try {
          const env = await boundSites.enter({
            tenant: record.tenantId,
            snapshot: config,
            auth: SiteAuth.parse(config.auth.implementation),
            authOptions: config.auth.options,
          })
          if (record.state === 'disposed' || closed) {
            await env.dispose()
            throw new SiteManagerClosedError()
          }
          record.env = env
          record.context = await env.deps.context.load()
          // Every request needs the authenticator; loading it here surfaces configuration errors at creation.
          await env.deps.auth.load()
          record.state = record.state === 'creating' ? 'active' : record.state
          creations += 1
          failureBackoff.delete(record.tenantId)
        }
        catch (error) {
          creationFailures += 1
          // Never leave a poisoned single-flight promise behind; back off future attempts.
          const previous = failureBackoff.get(record.tenantId)
          const count = (previous?.count ?? 0) + 1
          const delay = Math.min(settings.creationBackoffMaxMs, settings.creationBackoffMs * 2 ** (count - 1))
          failureBackoff.set(record.tenantId, { count, until: Date.now() + delay, error })
          record.state = 'disposed'
          records.delete(record.key)
          grantWaiter()
          throw error
        }
      })()
      return record.creation
    }

    const acquire = async (tenantId: string, purpose: LeasePurpose): Promise<SiteLease> => {
      void purpose
      for (let attempt = 1; ; attempt += 1) {
        if (closed) throw new SiteManagerClosedError()
        const backoff = failureBackoff.get(tenantId)
        if (backoff && Date.now() < backoff.until) {
          throw new Error(`Site ${tenantId} creation is backing off after ${backoff.count} failure(s) until ${new Date(backoff.until).toISOString()}: ${backoff.error instanceof Error ? backoff.error.message : String(backoff.error)}`)
        }
        const config = await readConfig(tenantId)
        const key = keyFor(tenantId, config.configRevision)

        // Rotate older revisions of this tenant to draining: no new leases, close when idle.
        for (const record of liveRecords()) {
          if (record.tenantId === tenantId && record.configRevision < config.configRevision && record.state !== 'draining') {
            record.state = 'draining'
            if (record.leases === 0) void disposeRecord(record)
          }
        }

        let record = records.get(key)
        if (record?.state === 'draining') {
          // This acquirer read an older configuration than a concurrent one: re-read and join the newer world.
          if (attempt < 5) continue
          throw new Error(`Site ${tenantId} configuration changed repeatedly while acquiring; giving up after ${attempt} attempts.`)
        }
        if (!record || record.state === 'disposed') {
          await reserveCapacity()
          if (closed) { reservations -= 1; throw new SiteManagerClosedError() }
          record = records.get(key)
          if (!record || record.state === 'disposed') {
            record = { key, tenantId, configRevision: config.configRevision, state: 'creating', leases: 0, lastReleasedAt: Date.now() }
            records.set(key, record)
            reservations -= 1 // the record now counts as live capacity
            record.leases += 1 // hold the record while creating so eviction cannot take it
            try {
              await create(record, config)
            }
            finally {
              record.leases -= 1
            }
          }
          else {
            reservations -= 1 // somebody else inserted the record meanwhile
          }
        }
        if (record.state === 'creating' && record.creation) {
          record.leases += 1
          try { await record.creation }
          finally { record.leases -= 1 }
        }
        const env = record.env
        const context = record.context
        if (record.state !== 'active' || !env || !context) {
          if (record.state === 'draining' && attempt < 5) continue
          throw new Error(`Site environment ${key} is ${record.state}.`)
        }
        record.leases += 1
        let released = false
        const current = record
        return {
          key,
          tenantId,
          configRevision: config.configRevision,
          env,
          context,
          release() {
            if (released) return
            released = true
            current.leases = Math.max(0, current.leases - 1)
            current.lastReleasedAt = Date.now()
            if (current.leases === 0 && (current.state === 'draining' || closed)) void disposeRecord(current)
            else if (current.leases === 0 && waiters.length > 0 && capacityUsed() >= settings.capacity) {
              // An idle env is worth more to a waiting acquirer than to a cache: evict it and hand the capacity over.
              evictions += 1
              void disposeRecord(current)
            }
          },
        }
      }
    }

    const sweep = async (): Promise<number> => {
      const now = Date.now()
      let evicted = 0
      for (const record of liveRecords()) {
        if (record.state !== 'active' || record.leases !== 0) continue
        if (now - record.lastReleasedAt >= settings.idleTtlMs) {
          evictions += 1
          evicted += 1
          await disposeRecord(record)
        }
      }
      return evicted
    }

    const sweeper = setInterval(() => { void sweep() }, settings.sweepIntervalMs)
    sweeper.unref()

    const shutdown = async (): Promise<{ readonly unreleasedLeases: readonly string[] }> => {
      if (!closed) {
        closed = true
        clearInterval(sweeper)
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer)
          waiter.reject(new SiteManagerClosedError())
        }
      }
      const deadline = Date.now() + settings.shutdownTimeoutMs
      while (liveRecords().some(record => record.leases > 0) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const unreleased = liveRecords().filter(record => record.leases > 0).map(record => `${record.key}#${record.leases}`)
      await Promise.all(liveRecords().map(record => disposeRecord(record)))
      return { unreleasedLeases: unreleased }
    }

    signal.addEventListener('abort', () => { closed = true }, { once: true })
    onDispose(async () => { await shutdown() })

    return {
      settings,
      acquire,
      invalidate(tenantId) {
        for (const record of liveRecords()) {
          if (record.tenantId !== tenantId || record.state === 'draining') continue
          record.state = 'draining'
          if (record.leases === 0) void disposeRecord(record)
        }
      },
      sweep,
      records: () => liveRecords().map(record => ({
        key: record.key,
        tenantId: record.tenantId,
        configRevision: record.configRevision,
        state: record.state,
        leases: record.leases,
        idleForMs: record.leases === 0 ? Date.now() - record.lastReleasedAt : undefined,
      })),
      stats: () => {
        const live = liveRecords()
        return {
          capacity: settings.capacity,
          records: live.length,
          active: live.filter(record => record.state === 'active' && record.leases > 0).length,
          idle: live.filter(record => record.state === 'active' && record.leases === 0).length,
          creating: live.filter(record => record.state === 'creating').length,
          draining: live.filter(record => record.state === 'draining').length,
          leases: live.reduce((sum, record) => sum + record.leases, 0),
          pendingAcquires: waiters.length,
          evictions,
          creations,
          creationFailures,
          rejectedForCapacity,
          closed,
        }
      },
      shutdown,
    }
  },
})

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
  /** `disposing`: the Env is being closed; it still occupies its unit of capacity until the close settles. */
  readonly state: 'creating' | 'active' | 'draining' | 'disposing' | 'disposed'
  readonly leases: number
  readonly idleForMs: number | undefined
}

export interface SiteManagerStats {
  readonly capacity: number
  /** Records occupying capacity: creating + active + draining + disposing. Never exceeds `capacity`. */
  readonly records: number
  readonly active: number
  readonly idle: number
  readonly creating: number
  readonly draining: number
  readonly disposing: number
  readonly leases: number
  readonly pendingAcquires: number
  readonly evictions: number
  readonly creations: number
  readonly creationFailures: number
  /** SiteEnv closes that rejected (reported through `onDisposalError`). */
  readonly disposalFailures: number
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

export class SiteCreationBackoffError extends Error {
  readonly code = 'SITE_CREATION_BACKOFF'
  constructor(
    readonly tenantId: string,
    readonly failures: number,
    readonly until: Date,
    cause: unknown,
  ) {
    super(`Site ${tenantId} creation is backing off after ${failures} failure(s) until ${until.toISOString()}.`, { cause })
    this.name = 'SiteCreationBackoffError'
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
  /**
   * Marks every environment of a tenant as stale: the next acquire reads the
   * store again and creates a fresh SiteEnv even when `configRevision` did not
   * change (a per-tenant generation is part of the key). Draining envs close
   * as soon as their last lease ends.
   */
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
  state: 'creating' | 'active' | 'draining' | 'disposing' | 'disposed'
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
    /** Bumped by invalidate(): part of the key, so a stale env is replaced even at the same configRevision. */
    const generations = new Map<string, number>()
    const failureBackoff = new Map<string, { count: number; until: number; error: unknown }>()
    let closed = false
    let evictions = 0
    let creations = 0
    let creationFailures = 0
    let disposalFailures = 0
    let rejectedForCapacity = 0

    const keyFor = (tenantId: string, configRevision: number): string =>
      `${runtimeId}|${tenantId}|${configRevision}|g${generations.get(tenantId) ?? 0}`

    const assertNotBackingOff = (tenantId: string): void => {
      const backoff = failureBackoff.get(tenantId)
      if (backoff && Date.now() < backoff.until) {
        throw new SiteCreationBackoffError(tenantId, backoff.count, new Date(backoff.until), backoff.error)
      }
    }

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

    /** A record nobody leases must not outlive its usefulness: draining (or closing) → dispose. */
    const settle = (record: SiteRecord): void => {
      if (record.leases === 0 && record.state !== 'disposed' && record.state !== 'disposing' && (record.state === 'draining' || closed)) {
        void disposeRecord(record)
      }
    }

    const reportDisposalFailure = (error: unknown, record: SiteRecord): void => {
      disposalFailures += 1
      try { settings.onDisposalError(error, { key: record.key, tenantId: record.tenantId, configRevision: record.configRevision }) }
      catch { /* a reporting hook must not change the manager's outcome */ }
    }

    /**
     * Closes a record's Env. The record keeps its unit of capacity until the
     * close has settled (state `disposing`); only then is it dropped and the
     * unit handed to the longest waiter, in the same tick, so nobody can slip a
     * new Env in ahead of the queue. Never rejects: a failed close is reported
     * and counted, and the Runtime keeps its own ledger of unsettled attempts.
     */
    const disposeRecord = (record: SiteRecord): Promise<void> => {
      if (record.disposal) return record.disposal
      record.state = 'disposing'
      record.disposal = (async () => {
        try { await record.env?.dispose() }
        catch (error) { reportDisposalFailure(error, record) }
        finally {
          record.state = 'disposed'
          records.delete(record.key)
          grantWaiter()
        }
      })()
      return record.disposal
    }

    /** Starts closing the longest-idle active record without leases. Never evicts a leased record. */
    const evictIdle = (): boolean => {
      const candidates = liveRecords()
        .filter(record => record.state === 'active' && record.leases === 0)
        .sort((left, right) => left.lastReleasedAt - right.lastReleasedAt)
      const victim = candidates[0]
      if (!victim) return false
      evictions += 1
      void disposeRecord(victim)
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

    /**
     * Returns holding one reservation. When the working set is full, the
     * acquirer starts closing the longest-idle Env (if any) and joins the
     * queue: the unit is granted, in arrival order, only once a close settles,
     * so the working set never exceeds `capacity` even while Envs are closing.
     */
    const reserveCapacity = async (): Promise<void> => {
      if (capacityUsed() < settings.capacity) {
        reservations += 1
        return
      }
      if (waiters.length >= settings.maxPendingAcquires) {
        rejectedForCapacity += 1
        throw new SiteCapacityError(
          `All ${settings.capacity} site environments are leased and ${waiters.length} acquirers are already waiting.`,
        )
      }
      evictIdle()
      await waitForCapacity() // resolved with a reservation already granted to this acquirer
      if (closed) { reservations -= 1; throw new SiteManagerClosedError() }
    }

    const create = (record: SiteRecord, config: SiteConfig): Promise<void> => {
      record.creation = (async () => {
        let env: EnvHandle<typeof SiteEntry['requires']> | undefined
        try {
          env = await boundSites.enter({
            tenant: record.tenantId,
            snapshot: config,
            auth: SiteAuth.parse(config.auth.implementation),
            authOptions: config.auth.options,
          })
          // From here on the Env belongs to the record: a shutdown that reaches the
          // record closes it, and every failure below closes it before giving up.
          record.env = env
          if (record.state === 'disposed' || record.state === 'disposing' || closed) throw new SiteManagerClosedError()
          record.context = await env.deps.context.load()
          // Every request needs the authenticator; loading it here surfaces configuration
          // errors at creation, including an override whose instance lacks the interface.
          const authenticator = await env.deps.auth.load()
          if (typeof authenticator !== 'object' || authenticator === null || typeof authenticator.authenticate !== 'function' || typeof authenticator.scheme !== 'string') {
            throw new TypeError(`Site ${record.tenantId}: the configured authenticator does not implement the Authenticator interface (scheme + authenticate()).`)
          }
          record.state = record.state === 'creating' ? 'active' : record.state
          creations += 1
          failureBackoff.delete(record.tenantId)
        }
        catch (error) {
          creationFailures += 1
          if (!(error instanceof SiteManagerClosedError)) {
            // Never leave a poisoned single-flight promise behind; back off future attempts.
            const previous = failureBackoff.get(record.tenantId)
            const count = (previous?.count ?? 0) + 1
            const delay = Math.min(settings.creationBackoffMaxMs, settings.creationBackoffMs * 2 ** (count - 1))
            failureBackoff.set(record.tenantId, { count, until: Date.now() + delay, error })
          }
          if (record.disposal) {
            // A shutdown or rotation already took the record; it closes the Env.
            await record.disposal
          }
          else {
            // A half-configured site is closed, never dropped: the Env was entered.
            record.state = 'disposing'
            try { await env?.dispose() }
            catch (disposalError) { reportDisposalFailure(disposalError, record) }
            finally {
              record.state = 'disposed'
              records.delete(record.key)
              grantWaiter()
            }
          }
          throw error
        }
      })()
      return record.creation
    }

    const acquire = async (tenantId: string, purpose: LeasePurpose): Promise<SiteLease> => {
      void purpose
      // A configuration that keeps changing while we acquire makes us re-read and
      // join the newest world; that is bounded by the acquire timeout, not by a
      // fixed number of attempts, so a burst of saves cannot fail live requests.
      const deadline = Date.now() + settings.acquireTimeoutMs
      const stillRetrying = (): boolean => Date.now() < deadline
      for (let attempt = 1; ; attempt += 1) {
        if (closed) throw new SiteManagerClosedError()
        assertNotBackingOff(tenantId)
        const config = await readConfig(tenantId)
        // Re-checked after the store round-trip: a burst of acquirers arriving while
        // the first one fails must join the backoff, not each start its own attempt.
        assertNotBackingOff(tenantId)
        const key = keyFor(tenantId, config.configRevision)

        // Rotate every other world of this tenant (older revision or invalidated
        // generation) to draining: no new leases, close as soon as it is idle.
        for (const record of liveRecords()) {
          if (record.tenantId === tenantId && record.key !== key && record.state !== 'draining') {
            record.state = 'draining'
            settle(record)
          }
        }

        let record = records.get(key)
        if (record?.state === 'draining') {
          // This acquirer read an older configuration than a concurrent one: re-read and join the newer world.
          if (stillRetrying()) continue
          throw new SiteCapacityError(`Site ${tenantId} configuration kept changing for ${settings.acquireTimeoutMs} ms while acquiring (${attempt} attempts).`)
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
              settle(record) // rotated to draining while it was being created → close it now
            }
          }
          else {
            reservations -= 1 // somebody else inserted the record meanwhile
          }
        }
        if (record.state === 'creating' && record.creation) {
          record.leases += 1
          try { await record.creation }
          finally {
            record.leases -= 1
            settle(record)
          }
        }
        const env = record.env
        const context = record.context
        if (record.state !== 'active' || !env || !context) {
          // The world this acquirer waited for was rotated away (configuration bump or
          // invalidate() while it was being created): read the current configuration
          // and join the current world instead of failing the caller.
          if ((record.state === 'draining' || record.state === 'disposing' || record.state === 'disposed') && stillRetrying()) continue
          throw new SiteCapacityError(`Site environment ${key} is ${record.state} and the configuration kept changing for ${settings.acquireTimeoutMs} ms (${attempt} attempts).`)
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

    /** Closes idle Envs past their TTL (and any leaseless draining Env) concurrently. Never rejects. */
    const sweep = async (): Promise<number> => {
      const now = Date.now()
      const closing: Promise<void>[] = []
      let evicted = 0
      for (const record of liveRecords()) {
        if (record.leases !== 0) continue
        if (record.state === 'draining') {
          // Defensive: a draining record with no lease is closed regardless of age.
          closing.push(disposeRecord(record))
          continue
        }
        if (record.state !== 'active') continue
        if (now - record.lastReleasedAt >= settings.idleTtlMs) {
          evictions += 1
          evicted += 1
          closing.push(disposeRecord(record))
        }
      }
      await Promise.all(closing)
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
        generations.set(tenantId, (generations.get(tenantId) ?? 0) + 1)
        for (const record of liveRecords()) {
          if (record.tenantId !== tenantId || record.state === 'draining') continue
          record.state = 'draining'
          settle(record)
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
          disposing: live.filter(record => record.state === 'disposing').length,
          leases: live.reduce((sum, record) => sum + record.leases, 0),
          pendingAcquires: waiters.length,
          evictions,
          creations,
          creationFailures,
          disposalFailures,
          rejectedForCapacity,
          closed,
        }
      },
      shutdown,
    }
  },
})

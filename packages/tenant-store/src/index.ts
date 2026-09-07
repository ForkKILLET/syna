import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Logger } from '@syna-demo/logger'
import { define } from './syna.js'

/** A tenant of the notification service and the credential its provider client needs. */
export interface Tenant {
  readonly id: string
  readonly name: string
  readonly apiKey: string
}

/** The tenant a world is about: an external fact, fixed for that world. */
export const CurrentTenant = define.input<Tenant>('current-tenant', {
  metadata: { displayName: 'Current tenant' },
})

export interface TenantStoreOptions {
  /** Directory holding `tenants/<id>.json` and `settings/<id>.json`. */
  readonly directory: string
}

/** Where the store lives: configuration, provided by the host when it opens the root world. */
export const TenantStoreConfig = define.input<TenantStoreOptions>('config', {
  metadata: { displayName: 'Tenant store configuration' },
})

export interface TenantStore {
  /** Numbered per opened pool, so a reader can tell whether two worlds share one. */
  readonly poolId: number
  readonly directory: string
  saveTenant(tenant: Tenant): Promise<void>
  listTenants(): Promise<readonly Tenant[]>
  /** The tenant's settings document, `{}` when nothing was stored yet. */
  readSettings(tenantId: string): Promise<Record<string, unknown>>
  writeSettings(tenantId: string, settings: Record<string, unknown>): Promise<void>
  stats(): { readonly queries: number; readonly closed: boolean }
}

let nextPoolId = 1

/**
 * A fake connection pool over a directory of JSON files: the resource a real
 * tenant store would hold. It is opened once per world that owns it, closed by
 * its own `onDispose`, and refuses work after that.
 */
export const TenantStore = define.service({
  requires: { config: TenantStoreConfig, logger: Logger },
  familyMetadata: {
    displayName: 'Tenant store',
    description: 'Tenants and their settings behind a fake connection pool.',
  },
  async setup({ config, logger }, { onDispose }): Promise<TenantStore> {
    const { directory } = config.read()
    const log = await logger.load()
    const poolId = nextPoolId++
    let queries = 0
    let closed = false
    const file = (kind: 'tenants' | 'settings', id: string): string => path.join(directory, kind, `${id}.json`)
    const query = <T>(description: string, work: () => T): T => {
      if (closed) throw new Error(`tenant store: pool #${poolId} is closed (${description})`)
      queries += 1
      log.debug(`tenant store: pool #${poolId} ${description}`)
      return work()
    }

    mkdirSync(path.join(directory, 'tenants'), { recursive: true })
    mkdirSync(path.join(directory, 'settings'), { recursive: true })
    log.info(`tenant store: pool #${poolId} opened on ${path.basename(directory)}`)
    onDispose(() => {
      closed = true
      log.info(`tenant store: pool #${poolId} closed`)
    })

    return {
      poolId,
      directory,
      async saveTenant(tenant) {
        query(`save tenant ${tenant.id}`, () => writeFileSync(file('tenants', tenant.id), `${JSON.stringify(tenant, null, 2)}\n`))
      },
      async listTenants() {
        return query('list tenants', () => readdirSync(path.join(directory, 'tenants'))
          .filter(name => name.endsWith('.json'))
          .sort()
          .map(name => JSON.parse(readFileSync(path.join(directory, 'tenants', name), 'utf8')) as Tenant))
      },
      async readSettings(tenantId) {
        return query(`read settings of ${tenantId}`, () => {
          try {
            return JSON.parse(readFileSync(file('settings', tenantId), 'utf8')) as Record<string, unknown>
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
            throw error
          }
        })
      },
      async writeSettings(tenantId, settings) {
        query(`write settings of ${tenantId}`, () => writeFileSync(file('settings', tenantId), `${JSON.stringify(settings, null, 2)}\n`))
      },
      stats() {
        return { queries, closed }
      },
    }
  },
})

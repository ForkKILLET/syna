import { Logger } from '@syna-demo/logger'
import { define } from './syna.js'

export interface PostgresOptions {
  readonly connectionString: string
  readonly applicationName?: string
}

export const PostgresConfig = define.input<PostgresOptions>('config', {
  metadata: {
    displayName: 'PostgreSQL configuration',
  },
})

interface PoolMetrics {
  recordQuery(): void
  readonly queryCount: number
}

const Metrics = define.service('pool-metrics', {
  setup(): PoolMetrics {
    let queryCount = 0
    return {
      recordQuery() {
        queryCount += 1
      },
      get queryCount() {
        return queryCount
      },
    }
  },
})

export interface Postgres {
  readonly poolId: number
  readonly connectionString: string
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly T[]>
  stats(): Promise<{ readonly queryCount: number }>
}

let nextPoolId = 1

export const Postgres = define.service({
  metadata: {
    displayName: 'PostgreSQL',
    description: 'A lifecycle-managed PostgreSQL-style connection pool.',
  },
  requires: {
    config: PostgresConfig,
    logger: Logger,
    metrics: Metrics,
  },
  async setup(
    { config, logger, metrics },
    { onDispose },
  ): Promise<Postgres> {
    const options = config.read()
    const log = await logger.load()
    const counters = await metrics.load()
    const poolId = nextPoolId++
    let closed = false

    log.info(`opening PostgreSQL pool #${poolId} for ${options.connectionString}`)
    onDispose(() => {
      closed = true
      log.info(`closing PostgreSQL pool #${poolId}`)
    })

    return {
      poolId,
      connectionString: options.connectionString,
      async query<T>(text: string, params: readonly unknown[] = []) {
        if (closed) throw new Error(`PostgreSQL pool #${poolId} is closed.`)
        counters.recordQuery()
        log.debug(`pool #${poolId}: ${text} ${JSON.stringify(params)}`)
        return [] as readonly T[]
      },
      async stats() {
        return { queryCount: counters.queryCount }
      },
    }
  },
})

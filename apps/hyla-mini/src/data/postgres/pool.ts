import pg from 'pg'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { define } from '../../syna.js'
import { DatabaseConfig } from './config.js'

/** Schema names are plain identifiers so they can travel unquoted in the startup `options`. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

export function assertSchemaName(schema: unknown): string {
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema)) {
    throw new TypeError(
      `DatabaseConfig.schema must match ${SCHEMA_NAME.source}, received ${JSON.stringify(schema)}.`,
    )
  }
  return schema
}

/** The subset of a pg client the store needs; satisfied by the pool and by a leased client. */
export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

export interface PoolStats {
  readonly total: number
  readonly idle: number
  readonly waiting: number
}

export interface DatabasePool extends SqlExecutor {
  readonly schema: string
  /** Leases one client for `fn` and always releases it. */
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  /** BEGIN, `fn`, COMMIT; ROLLBACK when `fn` throws. Always releases the client. */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  stats(): PoolStats
}

/** Adapts a pg client or pool to `SqlExecutor` (pg wants a mutable params array). */
export function executorOf(target: Pick<PoolClient, 'query'> | Pick<pg.Pool, 'query'>): SqlExecutor {
  return {
    query<Row extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      return (target as Pick<PoolClient, 'query'>).query<Row>(text, params === undefined ? undefined : [...params])
    },
  }
}

export const DatabasePool = define.service('database-pool', {
  metadata: {
    displayName: 'PostgreSQL pool',
    description: 'One pg.Pool per deployment, pinned to the configured schema via search_path.',
  },
  requires: { config: DatabaseConfig },
  async setup({ config }, { onDispose }): Promise<DatabasePool> {
    const settings = config.read()
    const schema = assertSchemaName(settings.schema)
    if (typeof settings.connectionString !== 'string' || settings.connectionString.length === 0) {
      throw new TypeError('DatabaseConfig.connectionString must be a non-empty string.')
    }
    const max = settings.max ?? 10
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new TypeError('DatabaseConfig.max must be a positive integer.')
    }

    const pool = new pg.Pool({
      connectionString: settings.connectionString,
      max,
      // Applied by the server during connection startup, so every leased client
      // already resolves unqualified names inside the configured schema only.
      options: `-c search_path=${schema}`,
    })
    // Idle clients that drop their connection emit here; without a listener the
    // process would crash. The next lease simply opens a fresh connection.
    pool.on('error', () => {})
    onDispose(() => pool.end())

    try {
      const probe = await pool.query<{ ok: number; search_path: string }>(
        'select 1 as ok, current_setting($1) as search_path',
        ['search_path'],
      )
      if (probe.rows[0]?.search_path !== schema) {
        throw new Error(`search_path is ${JSON.stringify(probe.rows[0]?.search_path)}, expected ${schema}.`)
      }
    }
    catch (error) {
      await pool.end()
      throw error
    }

    const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect()
      let broken: Error | undefined
      try {
        return await fn(client)
      }
      catch (error) {
        broken = error instanceof Error ? error : new Error(String(error))
        throw error
      }
      finally {
        // A thrown error may have left the connection in an unknown state; destroy it.
        client.release(broken)
      }
    }

    return {
      schema,
      query: executorOf(pool).query,
      withClient,
      withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        return withClient(async client => {
          await client.query('BEGIN')
          try {
            const result = await fn(client)
            await client.query('COMMIT')
            return result
          }
          catch (error) {
            try {
              await client.query('ROLLBACK')
            }
            catch {
              // The connection is unusable; withClient destroys it because we rethrow.
            }
            throw error
          }
        })
      },
      stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    }
  },
})

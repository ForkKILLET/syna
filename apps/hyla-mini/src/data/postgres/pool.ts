import pg, { DatabaseError } from 'pg'
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
  /**
   * Connections the pool has closed and dropped since it was created: leased
   * clients destroyed after a connection-level error, and idle clients whose
   * connection went away. Business errors never count here.
   */
  readonly removed: number
}

export interface DatabasePool extends SqlExecutor {
  readonly schema: string
  /**
   * Leases one client for `fn` and always releases it. The connection is
   * destroyed only when it is known to be broken: a connection-level error
   * (`isConnectionError`), an error event on the leased client, or a
   * transaction control statement that failed. Any other error hands the
   * connection back to the pool.
   */
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  /** BEGIN, `fn`, COMMIT; ROLLBACK when `fn` or the COMMIT throws. Always releases the client. */
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

const CONNECTION_ERRNO: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN',
])
/** SQLSTATE class 08 (connection exception) and the operator-intervention codes that end the session. */
const CONNECTION_SQLSTATE: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03'])
const CONNECTION_MESSAGE = /connection terminated|connection ended|client was closed|client has encountered a connection error|the database system is (?:starting|shutting)/i

/**
 * Whether an error means the connection it happened on is unusable. Everything
 * else — constraint violations, bad SQL, a raised exception, a statement
 * timeout — leaves the connection healthy once the transaction is rolled back.
 */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof DatabaseError) {
    const code = error.code ?? ''
    return code.startsWith('08') || CONNECTION_SQLSTATE.has(code)
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && CONNECTION_ERRNO.has(code)) return true
    return CONNECTION_MESSAGE.test(error.message)
  }
  return false
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
    /** Clients whose connection is known to be unusable; destroyed when their lease ends. */
    const broken = new WeakSet<PoolClient>()
    // pg-pool listens for errors only while a client is idle. A connection that
    // dies while leased, between two queries, would otherwise raise an unhandled
    // 'error' event; here it just marks the client for destruction.
    pool.on('connect', client => {
      client.on('error', () => { broken.add(client) })
    })
    let removed = 0
    /** Counted at release time so `stats()` is exact right after the lease ends; pg-pool's own event fires later. */
    const destroyedHere = new WeakSet<PoolClient>()
    pool.on('remove', client => {
      if (!destroyedHere.has(client)) removed += 1
    })

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
      // Not yet registered with onDispose: end it here exactly once.
      await pool.end()
      throw error
    }
    onDispose(() => pool.end())

    const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect()
      let destroy: Error | undefined
      try {
        return await fn(client)
      }
      catch (error) {
        if (isConnectionError(error)) destroy = error instanceof Error ? error : new Error(String(error))
        throw error
      }
      finally {
        if (destroy === undefined && broken.has(client)) destroy = new Error('The connection failed while it was leased; it is discarded.')
        if (destroy !== undefined) {
          destroyedHere.add(client)
          removed += 1
        }
        // With an error the pool closes and drops the connection; without one it goes back to the idle set.
        client.release(destroy)
      }
    }

    const rollback = async (client: PoolClient): Promise<void> => {
      try {
        await client.query('ROLLBACK')
      }
      catch {
        // Transaction control itself failed: the connection is unusable and must not be reused.
        broken.add(client)
      }
    }

    return {
      schema,
      query: executorOf(pool).query,
      withClient,
      withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        return withClient(async client => {
          try {
            await client.query('BEGIN')
          }
          catch (error) {
            broken.add(client)
            throw error
          }
          let result: T
          try {
            result = await fn(client)
          }
          catch (error) {
            await rollback(client)
            throw error
          }
          try {
            await client.query('COMMIT')
          }
          catch (error) {
            // A failed COMMIT has already been rolled back by the server; the ROLLBACK
            // is a no-op that proves the connection still answers.
            await rollback(client)
            throw error
          }
          return result
        })
      },
      stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, removed }),
    }
  },
})

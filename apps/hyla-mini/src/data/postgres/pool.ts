import pg, { DatabaseError } from 'pg'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { define } from '../../syna.js'
import { TransactionAbortedError } from '../common.js'
import { DatabaseConfig } from './config.js'

/** Schema names are plain identifiers so they can travel unquoted in the startup `options`. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

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
  /** Leases queued because every connection is in use. */
  readonly waiting: number
  /** Connections currently handed out by `withClient` / `withTransaction`. */
  readonly leased: number
  /**
   * Connections the pool has closed and dropped since it was created: leased
   * clients destroyed after a connection-level error, idle clients whose
   * connection went away, and leases the disposal had to terminate. Business
   * errors never count here.
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
  /**
   * BEGIN, `fn`, COMMIT; ROLLBACK when `fn` or the COMMIT throws. Always
   * releases the client. A COMMIT the server answers with a ROLLBACK tag (a
   * statement inside `fn` had failed and `fn` went on) is
   * `TransactionAbortedError`, never a silent success.
   */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
  stats(): PoolStats
}

/** Thrown to leases requested, or still queued, once the pool's disposal has started. */
export class PoolClosedError extends Error {
  override readonly name = 'PoolClosedError'
  readonly code = 'POOL_CLOSED'
  constructor() {
    super('The PostgreSQL pool is closed; no connection can be leased.')
  }
}

/** Reported by the pool's disposal when leased connections had to be terminated. */
export class PoolCloseTimeoutError extends Error {
  override readonly name = 'PoolCloseTimeoutError'
  readonly code = 'POOL_CLOSE_TIMEOUT'
  constructor(readonly terminated: number, readonly closeTimeoutMs: number) {
    super(`${terminated} leased PostgreSQL connection(s) were still in use ${closeTimeoutMs} ms after the pool started closing and were terminated.`)
  }
}

/** Adapts a pg client or pool to `SqlExecutor` (pg wants a mutable params array). */
export function executorOf(target: Pick<PoolClient, 'query'> | Pick<pg.Pool, 'query'>): SqlExecutor {
  return {
    query<Row extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      return (target as Pick<PoolClient, 'query'>).query<Row>(text, params === undefined ? undefined : [...params])
    },
  }
}

/**
 * An executor on one leased client whose statements run one after another
 * even when they are issued concurrently: a unit of work may fire several
 * mutations at once (`Promise.all`), and a client accepts only one statement
 * at a time (pg queues them today and stops doing so in pg 9).
 */
export function serialExecutorOf(target: Pick<PoolClient, 'query'>): SqlExecutor {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    query<Row extends QueryResultRow>(text: string, params?: readonly unknown[]) {
      const run = () => target.query<Row>(text, params === undefined ? undefined : [...params])
      const next = tail.then(run, run)
      tail = next.then(() => undefined, () => undefined)
      return next
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

function nonNegativeInteger(value: unknown, fallback: number, what: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${what} must be a non-negative integer.`)
  return value as number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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
    const lockTimeoutMs = nonNegativeInteger(settings.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'DatabaseConfig.lockTimeoutMs')
    const closeTimeoutMs = nonNegativeInteger(settings.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'DatabaseConfig.closeTimeoutMs')

    const pool = new pg.Pool({
      connectionString: settings.connectionString,
      max,
      // Applied by the server during connection startup, so every leased client
      // already resolves unqualified names inside the configured schema only, and
      // never waits for a lock longer than the configured bound.
      options: `-c search_path=${schema} -c lock_timeout=${lockTimeoutMs}`,
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

    let closing = false
    /** Leases handed out and not yet released. */
    const leased = new Set<PoolClient>()
    /** Leases the disposal terminated: their `withClient` must not release them a second time. */
    const terminated = new WeakSet<PoolClient>()
    /** Leases still waiting for a connection; rejected when the pool closes (pg-pool would leave them pending). */
    const waiters = new Set<{ reject(error: Error): void }>()
    const connect = (): Promise<PoolClient> => new Promise((resolve, reject) => {
      const waiter = { reject: (error: Error) => { waiters.delete(waiter); reject(error) } }
      waiters.add(waiter)
      pool.connect().then(client => {
        if (!waiters.has(waiter)) {
          // Already rejected by the disposal: the connection goes straight back.
          client.release()
          return
        }
        waiters.delete(waiter)
        resolve(client)
      }, error => {
        if (waiters.has(waiter)) waiter.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })

    onDispose(async () => {
      closing = true
      for (const waiter of [...waiters]) waiter.reject(new PoolClosedError())
      const deadline = Date.now() + closeTimeoutMs
      while (leased.size > 0 && Date.now() < deadline) await sleep(10)
      const stuck = [...leased]
      for (const client of stuck) {
        // A lease that did not come back in time is terminated: its pending query
        // fails with a connection error and the caller's `withClient` unwinds.
        terminated.add(client)
        leased.delete(client)
        destroyedHere.add(client)
        removed += 1
        client.release(new Error(`The PostgreSQL pool closed while this connection was leased; it is terminated.`))
      }
      await pool.end()
      if (stuck.length > 0) throw new PoolCloseTimeoutError(stuck.length, closeTimeoutMs)
    })

    const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      if (closing) throw new PoolClosedError()
      const client = await connect()
      leased.add(client)
      let destroy: Error | undefined
      try {
        return await fn(client)
      }
      catch (error) {
        if (isConnectionError(error)) destroy = error instanceof Error ? error : new Error(String(error))
        throw error
      }
      finally {
        leased.delete(client)
        if (!terminated.has(client)) {
          if (destroy === undefined && broken.has(client)) destroy = new Error('The connection failed while it was leased; it is discarded.')
          if (destroy !== undefined) {
            destroyedHere.add(client)
            removed += 1
          }
          // With an error the pool closes and drops the connection; without one it goes back to the idle set.
          client.release(destroy)
        }
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
          let commit: QueryResult
          try {
            commit = await client.query('COMMIT')
          }
          catch (error) {
            // A failed COMMIT has already been rolled back by the server; the ROLLBACK
            // is a no-op that proves the connection still answers.
            await rollback(client)
            throw error
          }
          // The server answers the COMMIT of an aborted transaction with a ROLLBACK tag, not an error.
          if (commit.command === 'ROLLBACK') throw new TransactionAbortedError()
          return result
        })
      },
      stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: waiters.size, leased: leased.size, removed }),
    }
  },
})

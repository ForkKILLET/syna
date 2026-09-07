import { define } from '../../syna.js'

export interface DatabaseSettings {
  readonly connectionString: string
  /** Schema that holds all the application's tables; created if missing. Lets tests isolate themselves. */
  readonly schema: string
  readonly max?: number
  /**
   * PostgreSQL `lock_timeout` for every connection of the pool, in milliseconds
   * (default 30 000; 0 disables it). A mutation that waits longer than this for
   * a row or advisory lock held by another session fails with SQLSTATE 55P03
   * instead of waiting for that session forever.
   */
  readonly lockTimeoutMs?: number
  /**
   * How long the pool's disposal waits for leased connections to come back
   * before terminating them and reporting it (default 5 000 ms).
   */
  readonly closeTimeoutMs?: number
}

export const DatabaseConfig = define.input<DatabaseSettings>('database-config', {
  metadata: { displayName: 'PostgreSQL settings' },
})

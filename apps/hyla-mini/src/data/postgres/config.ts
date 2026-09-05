import { define } from '../../syna.js'

export interface DatabaseSettings {
  readonly connectionString: string
  /** Schema that holds all Hyla-mini tables; created if missing. Lets tests isolate themselves. */
  readonly schema: string
  readonly max?: number
}

export const DatabaseConfig = define.input<DatabaseSettings>('database-config', {
  metadata: { displayName: 'PostgreSQL settings' },
})

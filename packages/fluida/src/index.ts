import { Postgres, PostgresConfig } from '@syna-demo/postgres'
import { define } from './syna.js'

export interface TransactionContext {
  readonly id: string
  readonly mode: 'read' | 'write'
}

export const CurrentTransaction = define.input<TransactionContext>(
  'current-transaction',
  { metadata: { displayName: 'Current transaction' } },
)

export interface Transaction {
  readonly id: string
  readonly mode: 'read' | 'write'
  readonly databasePool: number
  commit(): Promise<void>
  rollback(): Promise<void>
  readonly state: 'open' | 'committed' | 'rolled-back'
}

export const Transaction = define.service('transaction', {
  requires: {
    database: Postgres,
    context: CurrentTransaction,
  },
  async setup(
    { database, context },
    { onDispose },
  ): Promise<Transaction> {
    const db = await database.load()
    const tx = context.read()
    let state: Transaction['state'] = 'open'

    onDispose(() => {
      if (state === 'open') state = 'rolled-back'
    })

    return {
      id: tx.id,
      mode: tx.mode,
      databasePool: db.poolId,
      async commit() {
        if (state !== 'open') throw new Error(`Transaction ${tx.id} is ${state}.`)
        state = 'committed'
      },
      async rollback() {
        if (state !== 'open') throw new Error(`Transaction ${tx.id} is ${state}.`)
        state = 'rolled-back'
      },
      get state() {
        return state
      },
    }
  },
})

export interface ArticleRepository {
  find(id: string): Promise<{ readonly id: string; readonly pool: number }>
}

export const ArticleRepository = define.service('article-repository', {
  requires: {
    transaction: Transaction,
  },
  setup({ transaction }): ArticleRepository {
    return {
      async find(id) {
        const tx = await transaction.load()
        return { id, pool: tx.databasePool }
      },
    }
  },
})

export const DatabaseEntry = define.entry('database', {
  requires: {
    database: Postgres,
  },
  parameters: {
    config: PostgresConfig,
  },
})

export const TransactionEntry = define.entry('transaction', {
  requires: {
    transaction: Transaction,
    articles: ArticleRepository,
  },
  parameters: {
    transaction: CurrentTransaction,
  },
})

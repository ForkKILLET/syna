import { createRuntime } from '@syna/core'
import {
  ArticleRepository,
  DatabaseEntry,
  Transaction,
  TransactionEntry,
} from '@syna-demo/fluida'
import { Postgres } from '@syna-demo/postgres'

console.log('\n=== Fluida-style demo ===')

const runtime = createRuntime({
  services: [Postgres, Transaction, ArticleRepository],
})

const databaseEnv = await runtime.enter(DatabaseEntry, {
  config: {
    connectionString: 'postgres://demo@localhost/fluida',
    applicationName: 'fluida-demo',
  },
})

const database = await databaseEnv.deps.database.load()
console.log('Shared database pool:', database.poolId)

const executeTransaction = async (id: string) => databaseEnv.run(
  TransactionEntry,
  { transaction: { id, mode: 'write' } },
  async ({ transaction, articles }, env) => {
    const tx = await transaction.load()
    const repository = await articles.load()
    const row = await repository.find(`article-${id}`)
    console.log(`${id}: tx uses pool ${tx.databasePool}; repository returned`, row)
    console.log(`${id}: local slot owners`, env.inspect().nodes
      .filter(node => node.label.includes('transaction') || node.label.includes('article-repository'))
      .map(node => `${node.label}=>${node.ownerEnvId}`))
    await tx.commit()
    return { tx, repository }
  },
)

const [first, second] = await Promise.all([
  executeTransaction('tx-a'),
  executeTransaction('tx-b'),
])

console.log('Transactions are distinct:', first.tx !== second.tx)
console.log('Repositories are distinct:', first.repository !== second.repository)
console.log('Both transactions share the same pool:',
  first.tx.databasePool === second.tx.databasePool
  && first.tx.databasePool === database.poolId,
)
console.log('Database stats:', await database.stats())

await databaseEnv.dispose()
await runtime.dispose()

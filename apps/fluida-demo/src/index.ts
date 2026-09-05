import assert from 'node:assert/strict'
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
    return { tx, repository, row }
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
const stats = await database.stats()
console.log('Database stats:', stats)

await databaseEnv.dispose()
const liveEnvs = runtime.inspect().liveEnvCount
await runtime.dispose()

// The demo checks what it printed (I-112): request-scoped Transaction and ArticleRepository per
// TransactionEntry world, one Postgres pool shared from the DatabaseEntry world above them.
assert.notEqual(first.tx, second.tx)
assert.notEqual(first.repository, second.repository)
assert.equal(first.tx.databasePool, database.poolId)
assert.equal(second.tx.databasePool, database.poolId)
assert.deepEqual(first.row, { id: 'article-tx-a', pool: database.poolId })
assert.deepEqual(second.row, { id: 'article-tx-b', pool: database.poolId })
assert.equal(first.tx.state, 'committed')
assert.equal(second.tx.state, 'committed')
assert.equal(stats.queryCount, 0)
assert.equal(liveEnvs, 0)
console.log('demo: OK')

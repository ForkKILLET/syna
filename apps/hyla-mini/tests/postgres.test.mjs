import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { createRuntime } from '@syna/core'
import {
  DatabaseConfig,
  DatabasePool,
  PostgresContentStore,
  define,
} from '../dist/index.js'
import { repositoryConformance } from './helpers/repository-conformance.mjs'

const connectionString = process.env.SYNA_TEST_PG_URL
if (!connectionString) {
  throw new Error(
    'SYNA_TEST_PG_URL is not set. The PostgreSQL tests never skip: run them through '
    + '`node scripts/pg-test-cluster.mjs with -- node --test apps/hyla-mini/tests/postgres.test.mjs` '
    + 'or export SYNA_TEST_PG_URL=postgres://user@host:port/db.',
  )
}

const schema = `hyla_test_${randomBytes(4).toString('hex')}`
const max = 4
const config = { connectionString, schema, max }

const StoreEntry = define.entry('test-postgres-store', {
  requires: { store: PostgresContentStore, pool: DatabasePool },
  parameters: { config: DatabaseConfig },
})
const ChildEntry = define.entry('test-postgres-child', {
  requires: { store: PostgresContentStore, pool: DatabasePool },
})

const runtime = createRuntime({ services: [DatabasePool, PostgresContentStore] })

after(async () => {
  await runtime.dispose()
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query(`drop schema if exists ${pg.escapeIdentifier(schema)} cascade`)
  }
  finally {
    await client.end()
  }
})

repositoryConformance('postgres', async () => {
  const env = await runtime.enter(StoreEntry, { config })
  return { store: await env.deps.store.load(), dispose: () => env.dispose() }
})

const draft = (id, extra = {}) => ({
  id, slug: id, locale: 'en', title: id, body: `${id}\n`, status: 'draft', categories: [], tags: [], ...extra,
})

describe('postgres: transactions, pool sharing and disposal', () => {
  let env
  let store
  let pool

  before(async () => {
    env = await runtime.enter(StoreEntry, { config })
    store = await env.deps.store.load()
    pool = await env.deps.pool.load()
  })

  it('uses the isolated schema for every table and pins search_path', async () => {
    assert.equal(store.backend, 'postgres')
    assert.equal(pool.schema, schema)
    const tables = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [schema],
    )
    assert.deepEqual(tables.rows.map(row => row.table_name), ['categories', 'posts', 'sites', 'tags'])
    const searchPath = await pool.withClient(client => client.query('show search_path'))
    assert.equal(searchPath.rows[0].search_path, schema)
    const inTransaction = await pool.withTransaction(client => client.query('show search_path'))
    assert.equal(inTransaction.rows[0].search_path, schema)
    const publicTables = await pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('posts', 'sites', 'categories', 'tags')",
    )
    assert.deepEqual(publicTables.rows, [], 'nothing leaked into public')
  })

  it('rolls back the whole transaction when work throws', async () => {
    const gamma = store.forTenant('gamma')
    await assert.rejects(
      store.transaction('gamma', async repository => {
        await repository.saveCategory({ slug: 'c', name: 'C' })
        await repository.saveTag({ slug: 't', name: 'T' })
        await repository.savePost(draft('gamma-1'))
        await repository.savePost(draft('gamma-2'))
        assert.equal((await repository.listPosts({ visibility: 'all' })).length, 2, 'visible inside the transaction')
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.deepEqual(await gamma.listPosts({ visibility: 'all' }), [])
    assert.deepEqual(await gamma.listCategories(), [])
    assert.deepEqual(await gamma.listTags(), [])
    assert.ok(!(await store.listTenants()).includes('gamma'))
    const rows = await pool.query('select count(*)::int as n from posts where tenant_id = $1', ['gamma'])
    assert.equal(rows.rows[0].n, 0)
    assert.equal(pool.stats().waiting, 0)

    // A slug conflict inside a transaction rolls back the earlier writes too.
    await assert.rejects(store.transaction('gamma', async repository => {
      await repository.savePost(draft('gamma-3'))
      await repository.savePost(draft('gamma-4', { slug: 'gamma-3' }))
    }))
    assert.equal(await gamma.getPostById('gamma-3'), undefined)
  })

  it('keeps concurrent transactions on different tenants from interleaving state', async () => {
    const count = 12
    const insertAll = tenantId => store.transaction(tenantId, async repository => {
      for (let index = 0; index < count; index += 1) {
        await repository.savePost(draft(`${tenantId}-${index}`, { createdAt: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` }))
        // Yield so the two transactions really interleave on the event loop.
        await new Promise(resolve => setImmediate(resolve))
      }
      const seen = await repository.listPosts({ visibility: 'all' })
      return seen.map(post => post.id)
    })
    const [c1, c2] = await Promise.all([insertAll('c1'), insertAll('c2')])
    assert.equal(c1.length, count)
    assert.equal(c2.length, count)
    assert.ok(c1.every(id => id.startsWith('c1-')))
    assert.ok(c2.every(id => id.startsWith('c2-')))
    assert.equal((await store.forTenant('c1').listPosts({ visibility: 'all' })).length, count)
    assert.equal((await store.forTenant('c2').listPosts({ visibility: 'all' })).length, count)
    assert.deepEqual((await store.listTenants()).filter(id => id.startsWith('c')), ['c1', 'c2'])
  })

  it('serializes conflicting writers on the unique (tenant_id, slug) constraint', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => store.transaction('race', repository => repository.savePost(draft(`race-${index}`, { slug: 'same' })))),
    )
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    assert.equal(fulfilled.length, 1, 'exactly one writer owns the slug')
    for (const result of results.filter(result => result.status === 'rejected')) {
      assert.equal(result.reason.name, 'SlugConflictError')
    }
    assert.equal((await store.forTenant('race').listPosts({ visibility: 'all' })).length, 1)
  })

  it('shares one pool across repositories and child Envs and stays within max', async () => {
    const child = await env.enter(ChildEntry)
    try {
      assert.strictEqual(await child.deps.pool.load(), pool, 'child Env loads the same pool instance')
      assert.strictEqual(await child.deps.store.load(), store, 'child Env loads the same store instance')
      const poolNodes = inspection => inspection.nodes.filter(node => node.label.startsWith(`${DatabasePool.family.id}@`))
      assert.equal(poolNodes(child.inspect()).length, 1)
      assert.equal(poolNodes(child.inspect())[0].slotId, poolNodes(env.inspect())[0].slotId)

      const alpha = store.forTenant('pool-a')
      const beta = store.forTenant('pool-b')
      let peak = 0
      const observe = () => { peak = Math.max(peak, pool.stats().total) }
      const timer = setInterval(observe, 1)
      try {
        await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? alpha : beta)
          .savePost(draft(`pool-${index}`))
          .then(observe)))
      }
      finally {
        clearInterval(timer)
      }
      observe()
      assert.ok(peak >= 2, `the pool did open several connections (peak ${peak})`)
      assert.ok(peak <= max, `pool total ${peak} must stay within max ${max}`)
      assert.equal(pool.stats().waiting, 0)
      assert.equal((await alpha.listPosts({ visibility: 'all' })).length, 20)
      assert.equal((await beta.listPosts({ visibility: 'all' })).length, 20)
    }
    finally {
      await child.dispose()
    }
    assert.ok(pool.stats().total >= 1, 'disposing the child does not close the shared pool')
    assert.equal((await pool.query('select 1 as ok')).rows[0].ok, 1)
  })

  it('ends the pool on runtime.dispose()', async () => {
    await runtime.dispose()
    await assert.rejects(pool.query('select 1'), /after calling end|ended|closed/i)
    await assert.rejects(store.forTenant('alpha').listPosts({ visibility: 'all' }))
    assert.equal(pool.stats().total, 0)
  })
})

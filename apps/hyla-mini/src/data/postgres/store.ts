import { DatabaseError } from 'pg'
import { define } from '../../syna.js'
import { ContentStoreContract } from '../../domain/content.js'
import type { ContentRepository, ContentStore } from '../../domain/content.js'
import {
  assertSafeSegment,
  comparePosts,
  matchesFilter,
  normalizeDomain,
  normalizePostInput,
} from '../../domain/model.js'
import type {
  Category,
  Post,
  PostFilter,
  PostInput,
  SiteConfigInput,
  Tag,
} from '../../domain/model.js'
import { parseSiteConfig } from '../../domain/site-config.js'
import {
  DomainConflictError,
  SlugConflictError,
  assertName,
  assertOutsideUnitOfWork,
  normalizeTimestamp,
  runUnitOfWork,
} from '../common.js'
import { applyMigrations } from './migrations.js'
import { DatabasePool, executorOf, serialExecutorOf } from './pool.js'
import type { SqlExecutor } from './pool.js'

interface PostRow {
  readonly id: string
  readonly tenant_id: string
  readonly slug: string
  readonly locale: Post['locale']
  readonly title: string
  readonly body: string
  readonly status: Post['status']
  readonly categories: string[]
  readonly primary_category: string | null
  readonly tags: string[]
  readonly revision: number
  readonly created_at: Date
  readonly updated_at: Date
}

interface NameRow {
  readonly tenant_id: string
  readonly slug: string
  readonly name: string
}

interface SiteRow {
  readonly config: SiteConfigInput
  readonly config_revision: number
}

const POST_COLUMNS = `id, tenant_id, slug, locale, title, body, status, categories,
  primary_category, tags, revision, created_at, updated_at`

function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    body: row.body,
    status: row.status,
    categories: row.categories,
    primaryCategory: row.primary_category ?? undefined,
    tags: row.tags,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function isUniqueViolation(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError && error.code === '23505'
}

/**
 * Every unit of work on a tenant (a public-path mutation, a `transaction()`)
 * starts by taking the tenant's transaction-scoped advisory lock: mutations of
 * one tenant are serialized, as they are on the filesystem backend, so two
 * overlapping saves cannot interleave (F-BD3-03) and two units of work cannot
 * deadlock on the rows they touch in a different order (F-BD3-07). Lock order:
 * tenant, then the claimed hosts (sorted).
 */
export async function lockTenant(tx: SqlExecutor, tenantId: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`hyla-mini:tenant:${tenantId}`])
}

/**
 * Runs one mutation as a unit of work. The public repository wraps every
 * mutation in a transaction of its own; the repository handed to
 * `ContentStore.transaction()` already runs inside one and passes through.
 */
export type MutationRunner = <T>(work: (tx: SqlExecutor) => Promise<T>) => Promise<T>

/**
 * Builds the tenant-scoped repository on one SQL executor: the shared pool for
 * plain calls, or a leased client inside `transaction()`. Every statement
 * carries `tenant_id = $1`; there is no cross-tenant read path. Every mutation
 * runs through `runMutation`, and advances the tenant's content version in
 * that same unit of work.
 */
export function repositoryOn(tenantId: string, sql: SqlExecutor, runMutation: MutationRunner = work => work(sql)): ContentRepository {
  assertSafeSegment(tenantId, 'tenantId')

  /** Every mutation advances the tenant's content version in the same unit of work. */
  const bump = async (tx: SqlExecutor): Promise<void> => {
    await tx.query(
      `insert into content_versions (tenant_id, version) values ($1, 1)
       on conflict (tenant_id) do update set version = content_versions.version + 1`,
      [tenantId],
    )
  }

  async function listPosts(filter: PostFilter): Promise<readonly Post[]> {
    const conditions = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    const add = (clause: string, value: unknown): void => {
      params.push(value)
      conditions.push(clause.replace('?', `$${params.length}`))
    }
    if (filter.visibility === 'public') add('status = ?', 'published')
    if (filter.locale !== undefined) add('locale = ?', filter.locale)
    if (filter.category !== undefined) add('? = any(categories)', filter.category)
    if (filter.tag !== undefined) add('? = any(tags)', filter.tag)
    const result = await sql.query<PostRow>(
      `select ${POST_COLUMNS} from posts where ${conditions.join(' and ')}`,
      params,
    )
    // The domain comparator is the single source of ordering for every backend.
    return result.rows.map(rowToPost).filter(post => matchesFilter(post, filter)).sort(comparePosts)
  }

  async function getPostById(id: string): Promise<Post | undefined> {
    const result = await sql.query<PostRow>(
      `select ${POST_COLUMNS} from posts where tenant_id = $1 and id = $2`,
      [tenantId, id],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : rowToPost(row)
  }

  async function savePost(tx: SqlExecutor, input: PostInput): Promise<Post> {
    const post = normalizePostInput(tenantId, input)
    const now = new Date().toISOString()
    const createdAt = post.createdAt === undefined ? null : normalizeTimestamp(post.createdAt, 'createdAt')
    const updatedAt = post.updatedAt === undefined ? now : normalizeTimestamp(post.updatedAt, 'updatedAt')

    const holder = await tx.query<{ id: string }>(
      'select id from posts where tenant_id = $1 and slug = $2 and id <> $3',
      [tenantId, post.slug, post.id],
    )
    const existing = holder.rows[0]
    if (existing !== undefined) throw new SlugConflictError(tenantId, post.slug, existing.id, post.id)

    let result
    try {
      // Identity is (tenant_id, id): the same id in another tenant is another post.
      result = await tx.query<PostRow>(
        `insert into posts (${POST_COLUMNS})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, coalesce($11::timestamptz, $13::timestamptz), $12::timestamptz)
         on conflict (tenant_id, id) do update set
           slug = excluded.slug,
           locale = excluded.locale,
           title = excluded.title,
           body = excluded.body,
           status = excluded.status,
           categories = excluded.categories,
           primary_category = excluded.primary_category,
           tags = excluded.tags,
           revision = posts.revision + 1,
           created_at = coalesce($11::timestamptz, posts.created_at),
           updated_at = excluded.updated_at
         returning ${POST_COLUMNS}`,
        [
          post.id, tenantId, post.slug, post.locale, post.title, post.body, post.status,
          [...post.categories], post.primaryCategory ?? null, [...post.tags],
          createdAt, updatedAt, now,
        ],
      )
    }
    catch (error) {
      // A concurrent writer took the slug between our check and the upsert.
      if (isUniqueViolation(error)) throw new SlugConflictError(tenantId, post.slug, '<concurrent>', post.id)
      throw error
    }
    const row = result.rows[0]
    if (row === undefined) throw new Error('savePost returned no row.')
    await bump(tx)
    return rowToPost(row)
  }

  async function saveSiteConfig(tx: SqlExecutor, input: SiteConfigInput) {
    if (input.tenantId !== tenantId) {
      throw new TypeError(`SiteConfig.tenantId ${JSON.stringify(input.tenantId)} does not match repository tenant ${tenantId}.`)
    }
    const config = parseSiteConfig(input, 'input')
    const claimed = [...new Set(config.domains.map(normalizeDomain).filter((host): host is string => host !== undefined))].sort()
    // Claims of one host serialize on a transaction-scoped advisory lock (taken in
    // sorted order, so two tenants claiming overlapping sets cannot deadlock); the
    // primary key of `domains` is the backstop for writers that bypass this code.
    for (const host of claimed) {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`hyla-mini:domain:${host}`])
    }
    // The conflict is decided before this tenant's own rows are touched: a unit of
    // work that handles the DomainConflictError keeps the rows it had (F-BD3-02).
    if (claimed.length > 0) {
      const conflict = await tx.query<{ normalized_host: string; tenant_id: string }>(
        'select normalized_host, tenant_id from domains where normalized_host = any($1::text[]) and tenant_id <> $2 order by normalized_host limit 1',
        [claimed, tenantId],
      )
      const owner = conflict.rows[0]
      if (owner !== undefined) throw new DomainConflictError(tenantId, owner.normalized_host, owner.tenant_id)
    }
    await tx.query('delete from domains where tenant_id = $1', [tenantId])
    if (claimed.length > 0) {
      try {
        await tx.query('insert into domains (normalized_host, tenant_id) select unnest($1::text[]), $2', [claimed, tenantId])
      }
      catch (error) {
        if (isUniqueViolation(error)) {
          const host = /\(normalized_host\)=\((.+)\)/.exec(error.detail ?? '')?.[1] ?? claimed[0]
          throw new DomainConflictError(tenantId, host as string, '<concurrent>')
        }
        throw error
      }
    }
    const result = await tx.query<{ config_revision: number }>(
      `insert into sites (tenant_id, config, config_revision) values ($1, $2::jsonb, 1)
       on conflict (tenant_id) do update set
         config = excluded.config,
         config_revision = sites.config_revision + 1
       returning config_revision`,
      [tenantId, JSON.stringify(config)],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('saveSiteConfig returned no row.')
    await bump(tx)
    return { ...config, configRevision: row.config_revision }
  }

  return {
    tenantId,
    listPosts,
    async getPost(slug, filter) {
      const result = await sql.query<PostRow>(
        `select ${POST_COLUMNS} from posts where tenant_id = $1 and slug = $2`,
        [tenantId, slug],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      const post = rowToPost(row)
      return matchesFilter(post, { visibility: filter.visibility }) ? post : undefined
    },
    getPostById,
    savePost: input => runMutation(tx => savePost(tx, input)),
    deletePost: id => runMutation(async tx => {
      const result = await tx.query('delete from posts where tenant_id = $1 and id = $2', [tenantId, id])
      const deleted = (result.rowCount ?? 0) > 0
      if (deleted) await bump(tx)
      return deleted
    }),
    async listCategories() {
      const result = await sql.query<NameRow>(
        'select tenant_id, slug, name from categories where tenant_id = $1 order by slug',
        [tenantId],
      )
      return result.rows.map((row): Category => ({ tenantId: row.tenant_id, slug: row.slug, name: row.name }))
    },
    saveCategory: category => runMutation(async tx => {
      const slug = assertSafeSegment(category.slug, 'Category slug')
      const name = assertName(category.name, 'Category name')
      await tx.query(
        `insert into categories (tenant_id, slug, name) values ($1, $2, $3)
         on conflict (tenant_id, slug) do update set name = excluded.name`,
        [tenantId, slug, name],
      )
      await bump(tx)
      return { tenantId, slug, name }
    }),
    async listTags() {
      const result = await sql.query<NameRow>(
        'select tenant_id, slug, name from tags where tenant_id = $1 order by slug',
        [tenantId],
      )
      return result.rows.map((row): Tag => ({ tenantId: row.tenant_id, slug: row.slug, name: row.name }))
    },
    saveTag: tag => runMutation(async tx => {
      const slug = assertSafeSegment(tag.slug, 'Tag slug')
      const name = assertName(tag.name, 'Tag name')
      await tx.query(
        `insert into tags (tenant_id, slug, name) values ($1, $2, $3)
         on conflict (tenant_id, slug) do update set name = excluded.name`,
        [tenantId, slug, name],
      )
      await bump(tx)
      return { tenantId, slug, name }
    }),
    async getSiteConfig() {
      const result = await sql.query<SiteRow>(
        'select config, config_revision from sites where tenant_id = $1',
        [tenantId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      // Whatever the row holds (a raw update, another program's document) is validated before it becomes a site.
      return parseSiteConfig({ ...row.config, tenantId, configRevision: row.config_revision }, 'stored')
    },
    saveSiteConfig: input => runMutation(tx => saveSiteConfig(tx, input)),
    async contentVersion() {
      const result = await sql.query<{ version: string | number }>(
        'select version from content_versions where tenant_id = $1',
        [tenantId],
      )
      return String(result.rows[0]?.version ?? 0)
    },
  }
}

const TENANT_TABLES = ['posts', 'categories', 'tags', 'domains', 'sites', 'content_versions'] as const

export function createPostgresContentStore(pool: DatabasePool): ContentStore {
  const shared: SqlExecutor = pool
  /**
   * A public-path mutation is a transaction of its own, serialized with the
   * tenant's other units of work: the write and the version bump commit
   * together or not at all. Issued inside `transaction()` of the same tenant it
   * would wait for that unit of work forever, so it is refused instead.
   */
  const inOwnTransaction = (tenantId: string): MutationRunner => async work => {
    assertOutsideUnitOfWork(tenantId, 'A public-repository mutation')
    return pool.withTransaction(async client => {
      const tx = executorOf(client)
      await lockTenant(tx, tenantId)
      return work(tx)
    })
  }
  return {
    backend: 'postgres',
    forTenant: tenantId => repositoryOn(tenantId, shared, inOwnTransaction(tenantId)),
    async listTenants() {
      // A tenant is whoever left a row in any table, as a directory is on the filesystem backend.
      const result = await pool.query<{ tenant_id: string }>(
        `${TENANT_TABLES.map(table => `select tenant_id from ${table}`).join(' union ')} order by 1`,
      )
      return result.rows.map(row => row.tenant_id)
    },
    async transaction(tenantId, work) {
      assertSafeSegment(tenantId, 'tenantId')
      return runUnitOfWork(tenantId, () => pool.withTransaction(async client => {
        // One client, statements one after another even when the work issues them at once.
        const tx = serialExecutorOf(client)
        await lockTenant(tx, tenantId)
        return work(repositoryOn(tenantId, tx))
      }))
    },
    async deleteTenant(tenantId) {
      assertSafeSegment(tenantId, 'tenantId')
      assertOutsideUnitOfWork(tenantId, 'deleteTenant()')
      await pool.withTransaction(async client => {
        const tx = executorOf(client)
        await lockTenant(tx, tenantId)
        for (const table of TENANT_TABLES) {
          await tx.query(`delete from ${table} where tenant_id = $1`, [tenantId])
        }
      })
    },
  }
}

export const PostgresContentStore = define.service('postgres-content-store', {
  metadata: { displayName: 'PostgreSQL content store' },
  provides: [ContentStoreContract],
  requires: { pool: DatabasePool },
  async setup({ pool }): Promise<ContentStore> {
    const database = await pool.load()
    await applyMigrations(database)
    return createPostgresContentStore(database)
  },
})

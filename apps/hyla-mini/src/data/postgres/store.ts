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
  SiteConfig,
  SiteConfigInput,
  Tag,
} from '../../domain/model.js'
import { DomainConflictError, SlugConflictError, assertName, normalizeTimestamp } from '../common.js'
import { applyMigrations } from './migrations.js'
import { DatabasePool, executorOf } from './pool.js'
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
 * Builds the tenant-scoped repository on one SQL executor: the shared pool for
 * plain calls, or a leased client inside `transaction()`. Every statement
 * carries `tenant_id = $1`; there is no cross-tenant read path.
 */
export function repositoryOn(tenantId: string, sql: SqlExecutor): ContentRepository {
  assertSafeSegment(tenantId, 'tenantId')

  /** Every mutation advances the tenant's content version in the same unit of work. */
  const bump = async (): Promise<void> => {
    await sql.query(
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

  async function savePost(input: PostInput): Promise<Post> {
    const post = normalizePostInput(tenantId, input)
    const now = new Date().toISOString()
    const createdAt = post.createdAt === undefined ? null : normalizeTimestamp(post.createdAt, 'createdAt')
    const updatedAt = post.updatedAt === undefined ? now : normalizeTimestamp(post.updatedAt, 'updatedAt')

    const holder = await sql.query<{ id: string }>(
      'select id from posts where tenant_id = $1 and slug = $2 and id <> $3',
      [tenantId, post.slug, post.id],
    )
    const existing = holder.rows[0]
    if (existing !== undefined) throw new SlugConflictError(tenantId, post.slug, existing.id, post.id)

    let result
    try {
      result = await sql.query<PostRow>(
        `insert into posts (${POST_COLUMNS})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, coalesce($11::timestamptz, $13::timestamptz), $12::timestamptz)
         on conflict (id) do update set
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
         where posts.tenant_id = $2
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
    if (row === undefined) {
      throw new Error(`Post id ${JSON.stringify(post.id)} already belongs to another tenant.`)
    }
    await bump()
    return rowToPost(row)
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
    savePost,
    async deletePost(id) {
      const result = await sql.query('delete from posts where tenant_id = $1 and id = $2', [tenantId, id])
      const deleted = (result.rowCount ?? 0) > 0
      if (deleted) await bump()
      return deleted
    },
    async listCategories() {
      const result = await sql.query<NameRow>(
        'select tenant_id, slug, name from categories where tenant_id = $1 order by slug',
        [tenantId],
      )
      return result.rows.map((row): Category => ({ tenantId: row.tenant_id, slug: row.slug, name: row.name }))
    },
    async saveCategory(category) {
      const slug = assertSafeSegment(category.slug, 'Category slug')
      const name = assertName(category.name, 'Category name')
      await sql.query(
        `insert into categories (tenant_id, slug, name) values ($1, $2, $3)
         on conflict (tenant_id, slug) do update set name = excluded.name`,
        [tenantId, slug, name],
      )
      await bump()
      return { tenantId, slug, name }
    },
    async listTags() {
      const result = await sql.query<NameRow>(
        'select tenant_id, slug, name from tags where tenant_id = $1 order by slug',
        [tenantId],
      )
      return result.rows.map((row): Tag => ({ tenantId: row.tenant_id, slug: row.slug, name: row.name }))
    },
    async saveTag(tag) {
      const slug = assertSafeSegment(tag.slug, 'Tag slug')
      const name = assertName(tag.name, 'Tag name')
      await sql.query(
        `insert into tags (tenant_id, slug, name) values ($1, $2, $3)
         on conflict (tenant_id, slug) do update set name = excluded.name`,
        [tenantId, slug, name],
      )
      await bump()
      return { tenantId, slug, name }
    },
    async getSiteConfig() {
      const result = await sql.query<SiteRow>(
        'select config, config_revision from sites where tenant_id = $1',
        [tenantId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return { ...row.config, tenantId, configRevision: row.config_revision } satisfies SiteConfig
    },
    async saveSiteConfig(config) {
      if (config.tenantId !== tenantId) {
        throw new TypeError(`SiteConfig.tenantId ${JSON.stringify(config.tenantId)} does not match repository tenant ${tenantId}.`)
      }
      const claimed = (Array.isArray(config.domains) ? config.domains : []).map(normalizeDomain).filter((host): host is string => host !== undefined)
      if (claimed.length > 0) {
        const conflict = await sql.query<{ tenant_id: string; domain: string }>(
          `select s.tenant_id, d.value as domain
           from sites s, jsonb_array_elements_text(s.config->'domains') as d
           where s.tenant_id <> $1 and lower(trim(d.value)) = any($2::text[])
           limit 1`,
          [tenantId, claimed],
        )
        const owner = conflict.rows[0]
        if (owner !== undefined) throw new DomainConflictError(tenantId, owner.domain, owner.tenant_id)
      }
      const result = await sql.query<{ config_revision: number }>(
        `insert into sites (tenant_id, config, config_revision) values ($1, $2::jsonb, 1)
         on conflict (tenant_id) do update set
           config = excluded.config,
           config_revision = sites.config_revision + 1
         returning config_revision`,
        [tenantId, JSON.stringify(config)],
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error('saveSiteConfig returned no row.')
      await bump()
      return { ...config, configRevision: row.config_revision }
    },
    async contentVersion() {
      const result = await sql.query<{ version: string | number }>(
        'select version from content_versions where tenant_id = $1',
        [tenantId],
      )
      return String(result.rows[0]?.version ?? 0)
    },
  }
}

export function createPostgresContentStore(pool: DatabasePool): ContentStore {
  const shared: SqlExecutor = pool
  return {
    backend: 'postgres',
    forTenant: tenantId => repositoryOn(tenantId, shared),
    async listTenants() {
      const result = await pool.query<{ tenant_id: string }>(
        'select tenant_id from sites union select tenant_id from posts order by 1',
      )
      return result.rows.map(row => row.tenant_id)
    },
    async transaction(tenantId, work) {
      assertSafeSegment(tenantId, 'tenantId')
      return pool.withTransaction(client => work(repositoryOn(tenantId, executorOf(client))))
    },
    async deleteTenant(tenantId) {
      assertSafeSegment(tenantId, 'tenantId')
      await pool.withTransaction(async client => {
        for (const table of ['posts', 'categories', 'tags', 'sites', 'content_versions']) {
          await client.query(`delete from ${table} where tenant_id = $1`, [tenantId])
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

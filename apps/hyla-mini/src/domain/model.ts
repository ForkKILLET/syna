/**
 * Hyla-mini data model. Deliberately small: enough for Site, Post, Category,
 * Tag, navigation/title configuration and render recipes. Language is ordinary
 * business data (a `locale` field), not a framework concept.
 */
export type Locale = 'zh-CN' | 'en'
export const LOCALES: readonly Locale[] = Object.freeze(['zh-CN', 'en'])

export type PostStatus = 'published' | 'draft' | 'private'

export interface Post {
  /** Stable record id. Never derived from slug, path or title. */
  readonly id: string
  readonly tenantId: string
  readonly slug: string
  readonly locale: Locale
  readonly title: string
  /** Markdown body. */
  readonly body: string
  readonly status: PostStatus
  /** Category slugs; `primaryCategory` is one of them (defaults to the first). */
  readonly categories: readonly string[]
  readonly primaryCategory: string | undefined
  readonly tags: readonly string[]
  /** Increments on every successful save. */
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Everything a caller supplies to create or update a post. Revision and timestamps are managed by the store. */
export interface PostInput {
  readonly id: string
  readonly slug: string
  readonly locale: Locale
  readonly title: string
  readonly body: string
  readonly status: PostStatus
  readonly categories: readonly string[]
  readonly primaryCategory?: string
  readonly tags: readonly string[]
  /** Fixture-controlled timestamps keep outputs comparable. Defaults to the store clock. */
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface Category {
  readonly tenantId: string
  readonly slug: string
  readonly name: string
}

export interface Tag {
  readonly tenantId: string
  readonly slug: string
  readonly name: string
}

export interface NavigationItem {
  readonly label: string
  readonly href: string
}

export interface ThemeSettings {
  readonly name: string
  readonly accent: string
}

/** JSON-safe reference to an admitted implementation; mirrors Syna's PersistentImplementationRef shape. */
export interface StoredImplementationRef {
  readonly kind: 'persistent-implementation-ref'
  readonly contractId: string
  readonly implementationId: string
  readonly version: string
}

export interface SiteAuthSettings {
  readonly implementation: StoredImplementationRef
  /** Implementation-specific options (JSON). Test adapters only; never production security. */
  readonly options: Readonly<Record<string, unknown>>
}

export interface SiteConfig {
  readonly tenantId: string
  readonly title: string
  readonly domains: readonly string[]
  readonly defaultLocale: Locale
  readonly theme: ThemeSettings
  readonly navigation: readonly NavigationItem[]
  /** Recipe documents by role. See render/recipe.ts for the JSON schema. */
  readonly recipes: {
    readonly body: RecipeDocument
    readonly comment: RecipeDocument
    readonly preview: RecipeDocument
  }
  readonly auth: SiteAuthSettings
  /** Increments on every successful save; it is part of the SiteEnv working-set key. */
  readonly configRevision: number
}

export type SiteConfigInput = Omit<SiteConfig, 'configRevision'>

export interface RecipeStage {
  /** Unique within a recipe; lets the same plugin family appear twice on purpose. */
  readonly occurrence: string
  readonly ref: StoredImplementationRef
  readonly optionsVersion: number
  readonly options: Readonly<Record<string, unknown>>
}

export interface RecipeDocument {
  readonly formatVersion: 1
  readonly name: string
  readonly stages: readonly RecipeStage[]
}

export interface PostFilter {
  /** `public` returns published posts only; `all` also returns drafts and private posts. */
  readonly visibility: 'public' | 'all'
  readonly locale?: Locale
  readonly category?: string
  readonly tag?: string
}

const SAFE_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Tenant ids, slugs and category/tag slugs are single lower-case path-safe segments. */
export function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value)
}

export function assertSafeSegment(value: unknown, what: string): string {
  if (!isSafeSegment(value)) {
    throw new TypeError(`${what} must be a lower-case path-safe segment, received ${JSON.stringify(value)}.`)
  }
  return value
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function isPostStatus(value: unknown): value is PostStatus {
  return value === 'published' || value === 'draft' || value === 'private'
}

/** Validates and normalizes a PostInput. Throws TypeError on invalid data. */
export function normalizePostInput(tenantId: string, input: PostInput): PostInput {
  assertSafeSegment(tenantId, 'tenantId')
  if (typeof input.id !== 'string' || input.id.trim().length === 0 || input.id.includes('/') || input.id.includes('..')) {
    throw new TypeError('Post id must be a non-empty string without path separators.')
  }
  assertSafeSegment(input.slug, 'Post slug')
  if (!isLocale(input.locale)) throw new TypeError(`Unsupported locale ${JSON.stringify(input.locale)}.`)
  if (typeof input.title !== 'string') throw new TypeError('Post title must be a string.')
  if (typeof input.body !== 'string') throw new TypeError('Post body must be a string.')
  if (!isPostStatus(input.status)) throw new TypeError(`Invalid post status ${JSON.stringify(input.status)}.`)
  const categories = [...new Set(input.categories.map(slug => assertSafeSegment(slug, 'Category slug')))]
  const tags = [...new Set(input.tags.map(slug => assertSafeSegment(slug, 'Tag slug')))]
  const primaryCategory = input.primaryCategory ?? categories[0]
  if (primaryCategory !== undefined && !categories.includes(primaryCategory)) {
    throw new TypeError(`primaryCategory ${primaryCategory} is not one of the post categories.`)
  }
  return {
    id: input.id,
    slug: input.slug,
    locale: input.locale,
    title: input.title,
    body: input.body,
    status: input.status,
    categories,
    ...(primaryCategory !== undefined ? { primaryCategory } : {}),
    tags,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
  }
}

/** Deterministic ordering used by every backend: newest first, then slug. */
export function comparePosts(left: Post, right: Post): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.slug.localeCompare(right.slug)
}

export function isPubliclyVisible(post: Post): boolean {
  return post.status === 'published'
}

export function matchesFilter(post: Post, filter: PostFilter): boolean {
  if (filter.visibility === 'public' && !isPubliclyVisible(post)) return false
  if (filter.locale !== undefined && post.locale !== filter.locale) return false
  if (filter.category !== undefined && !post.categories.includes(filter.category)) return false
  if (filter.tag !== undefined && !post.tags.includes(filter.tag)) return false
  return true
}

/**
 * Canonical form of a host name for the domain table and for domain-claim
 * checks: trimmed, lower-cased, port removed. Returns undefined for anything
 * that is not a plain DNS-style name.
 */
export function normalizeDomain(value: string | undefined): string | undefined {
  if (!value) return undefined
  const host = value.trim().toLowerCase().replace(/:\d+$/, '')
  return /^[a-z0-9.-]+$/.test(host) ? host : undefined
}

import type { Post, PostInput } from '../domain/model.js'

/** Thrown when a slug is already used by a different post id inside the same tenant. */
export class SlugConflictError extends Error {
  override readonly name = 'SlugConflictError'
  constructor(
    readonly tenantId: string,
    readonly slug: string,
    readonly existingId: string,
    readonly requestedId: string,
  ) {
    super(
      `Slug ${JSON.stringify(slug)} of tenant ${tenantId} is already used by post ${existingId}; `
      + `post ${requestedId} cannot take it.`,
    )
  }
}

/** Thrown when a site configuration claims a domain another tenant already owns. */
export class DomainConflictError extends Error {
  override readonly name = 'DomainConflictError'
  readonly code = 'DOMAIN_CONFLICT'
  constructor(
    readonly tenantId: string,
    readonly domain: string,
    readonly ownerTenantId: string,
  ) {
    super(`Domain ${JSON.stringify(domain)} is already claimed by tenant ${ownerTenantId}; tenant ${tenantId} cannot take it.`)
  }
}

/** Parses a caller-supplied timestamp and returns it as a canonical ISO-8601 string. */
export function normalizeTimestamp(value: string, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${what} must be an ISO-8601 timestamp, received ${JSON.stringify(value)}.`)
  }
  return new Date(value).toISOString()
}

export interface RevisionState {
  readonly revision: number
  readonly createdAt: string
}

export interface ResolvedRevision {
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Shared store bookkeeping for one savePost: revision = previous + 1 (1 for a
 * new post); createdAt from input, else previous, else the clock; updatedAt
 * from input, else the clock.
 */
export function resolveRevision(
  input: Pick<PostInput, 'createdAt' | 'updatedAt'>,
  previous: RevisionState | undefined,
  now: string = new Date().toISOString(),
): ResolvedRevision {
  const createdAt = input.createdAt !== undefined
    ? normalizeTimestamp(input.createdAt, 'createdAt')
    : previous?.createdAt ?? now
  const updatedAt = input.updatedAt !== undefined
    ? normalizeTimestamp(input.updatedAt, 'updatedAt')
    : now
  return { revision: (previous?.revision ?? 0) + 1, createdAt, updatedAt }
}

/** Builds the stored Post from validated input and resolved bookkeeping. */
export function buildPost(tenantId: string, input: PostInput, resolved: ResolvedRevision): Post {
  return {
    id: input.id,
    tenantId,
    slug: input.slug,
    locale: input.locale,
    title: input.title,
    body: input.body,
    status: input.status,
    categories: [...input.categories],
    primaryCategory: input.primaryCategory,
    tags: [...input.tags],
    revision: resolved.revision,
    createdAt: resolved.createdAt,
    updatedAt: resolved.updatedAt,
  }
}

export function assertName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${what} must be a non-empty string.`)
  }
  return value
}

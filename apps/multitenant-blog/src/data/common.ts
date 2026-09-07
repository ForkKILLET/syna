import { AsyncLocalStorage } from 'node:async_hooks'
import { assertNoNul } from '../domain/model.js'
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

/**
 * Thrown by the PostgreSQL backend when a unit of work reaches its COMMIT after
 * a statement inside it failed: the server had already rolled the transaction
 * back and answers the COMMIT with a ROLLBACK tag instead of an error. A unit
 * of work that catches a failed statement and continues ends here, never with
 * a silently discarded result (audit 3, F-BD3-01).
 */
export class TransactionAbortedError extends Error {
  override readonly name = 'TransactionAbortedError'
  readonly code = 'TRANSACTION_ABORTED'
  constructor() {
    super(
      'The unit of work did not commit: a statement inside it failed earlier and PostgreSQL rolled the whole '
      + 'transaction back. A unit of work must not continue past a failed statement.',
    )
  }
}

/**
 * Thrown when a public-repository mutation of tenant T, or another
 * `transaction(T)`, is issued from inside the unit of work of `transaction(T)`:
 * both would wait for the lock that unit of work holds, forever (audit 3,
 * F-BD3-04). The repository handed to the unit of work is the one to use.
 */
export class TransactionReentrancyError extends Error {
  override readonly name = 'TransactionReentrancyError'
  readonly code = 'TRANSACTION_REENTRANCY'
  constructor(readonly tenantId: string, operation: string) {
    super(
      `${operation} of tenant ${tenantId} was issued inside transaction(${JSON.stringify(tenantId)}) and would wait `
      + 'for that unit of work forever; use the repository handed to the unit of work.',
    )
  }
}

/** The tenants whose unit of work the current asynchronous context runs inside. */
const unitsOfWork = new AsyncLocalStorage<ReadonlySet<string>>()

/** Whether the current asynchronous context is inside `transaction(tenantId)`. */
export function insideUnitOfWork(tenantId: string): boolean {
  return unitsOfWork.getStore()?.has(tenantId) ?? false
}

/** Refuses `operation` when it runs inside `transaction(tenantId)` (it would deadlock on that unit of work's lock). */
export function assertOutsideUnitOfWork(tenantId: string, operation: string): void {
  if (insideUnitOfWork(tenantId)) throw new TransactionReentrancyError(tenantId, operation)
}

/** Runs `work` as the unit of work of `tenantId`; nested public mutations of that tenant are then refused instead of hanging. */
export function runUnitOfWork<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  assertOutsideUnitOfWork(tenantId, 'transaction()')
  return unitsOfWork.run(new Set([...(unitsOfWork.getStore() ?? []), tenantId]), work)
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
  return assertNoNul(value, what)
}

import type { Post } from '../domain/model.js'

/**
 * Who is making a request, as established by an Authenticator. Consumers only
 * ever see this type; they never look at cookies, tokens or user-name strings.
 */
export type Principal =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'user'
      readonly userId: string
      /** Tenant the identity belongs to. Authorization is decided per tenant, never by identity alone. */
      readonly tenantId: string
      readonly roles: readonly string[]
    }

export const ANONYMOUS: Principal = Object.freeze({ kind: 'anonymous' })

export interface RequestHeaders {
  readonly [name: string]: string | undefined
}

/** Authorization is application logic, separate from authentication. */
export function isMemberOf(principal: Principal, tenantId: string): boolean {
  return principal.kind === 'user' && principal.tenantId === tenantId
}

export function canViewPost(principal: Principal, tenantId: string, post: Post): boolean {
  if (post.tenantId !== tenantId) return false
  if (post.status === 'published') return true
  if (post.status === 'private') return isMemberOf(principal, tenantId)
  // Drafts are visible to editors of the same tenant only.
  return isMemberOf(principal, tenantId) && principal.kind === 'user' && principal.roles.includes('editor')
}

/** Cache partition for a principal: anonymous readers share one partition per tenant; members another; other identities are anonymous. */
export function visibilityClass(principal: Principal, tenantId: string): string {
  if (!isMemberOf(principal, tenantId) || principal.kind !== 'user') return 'anonymous'
  return principal.roles.includes('editor') ? 'editor' : 'member'
}

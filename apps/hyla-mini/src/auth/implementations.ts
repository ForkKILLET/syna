import { createHmac, timingSafeEqual } from 'node:crypto'
import { define } from '../syna.js'
import { AuthOptions, AuthenticatorContract, type Authenticator } from './contract.js'
import { ANONYMOUS, type Principal } from './principal.js'

/**
 * TEST ADAPTERS. Both authenticators are local, deterministic implementations
 * used to prove that the Auth Contract is replaceable. They are not production
 * security: sessions live in the site configuration and token secrets are
 * plain strings.
 */

interface SessionRecord {
  readonly userId: string
  readonly tenantId: string
  readonly roles: readonly string[]
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    let value: string
    try {
      value = decodeURIComponent(part.slice(index + 1).trim())
    }
    catch {
      continue // a malformed percent-encoding is no cookie, not a 500
    }
    cookies[part.slice(0, index).trim()] = value
  }
  return cookies
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord).userId === 'string'
    && typeof (value as SessionRecord).tenantId === 'string'
    && Array.isArray((value as SessionRecord).roles)
}

/** Self-hosted style: a `hyla_session` cookie looked up in a session table from the site options. */
export const SessionAuth = define.service('session-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup({ options }): Authenticator {
    const settings = options.read()
    const table = settings.sessions
    const sessions = new Map<string, SessionRecord>()
    if (typeof table === 'object' && table !== null) {
      for (const [id, record] of Object.entries(table as Record<string, unknown>)) {
        if (isSessionRecord(record)) sessions.set(id, record)
      }
    }
    return {
      scheme: 'session-cookie',
      async authenticate(headers) {
        const id = parseCookies(headers.cookie).hyla_session
        const record = id ? sessions.get(id) : undefined
        if (!record) return ANONYMOUS
        return { kind: 'user', userId: record.userId, tenantId: record.tenantId, roles: [...record.roles] }
      },
    }
  },
})

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signToken(secret: string, claims: { userId: string; tenantId: string; roles: readonly string[]; exp: number }): string {
  const payload = base64url(JSON.stringify(claims))
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/** Platform style: an HMAC-signed bearer token (stand-in for a signed IdP assertion). */
export const SignedTokenAuth = define.service('signed-token-auth', {
  provides: [AuthenticatorContract],
  requires: { options: AuthOptions },
  setup({ options }): Authenticator {
    const settings = options.read()
    const secret = typeof settings.secret === 'string' ? settings.secret : undefined
    if (!secret) throw new TypeError('signed-token-auth requires a string `secret` option.')
    const now = typeof settings.now === 'number' ? () => settings.now as number : () => Date.now()
    return {
      scheme: 'signed-token',
      async authenticate(headers) {
        const header = headers.authorization
        if (!header || !header.startsWith('Bearer ')) return ANONYMOUS
        const token = header.slice('Bearer '.length).trim()
        const dot = token.lastIndexOf('.')
        if (dot < 0) return ANONYMOUS
        const payload = token.slice(0, dot)
        const signature = Buffer.from(token.slice(dot + 1), 'base64url')
        const expected = createHmac('sha256', secret).update(payload).digest()
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return ANONYMOUS
        let claims: unknown
        try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
        catch { return ANONYMOUS }
        if (!isSessionRecord(claims)) return ANONYMOUS
        const exp = (claims as { exp?: unknown }).exp
        if (typeof exp !== 'number' || exp * 1000 < now()) return ANONYMOUS
        const principal: Principal = { kind: 'user', userId: claims.userId, tenantId: claims.tenantId, roles: [...claims.roles] }
        return principal
      },
    }
  },
})

export const AUTHENTICATORS = Object.freeze([SessionAuth, SignedTokenAuth])

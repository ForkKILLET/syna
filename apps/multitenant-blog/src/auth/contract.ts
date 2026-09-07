import { define } from '../syna.js'
import type { Principal, RequestHeaders } from './principal.js'

/**
 * Minimal Hyla authentication Contract. Implementations turn request headers
 * into a Principal. They are replaceable per site through the SiteAuth Binding;
 * content and rendering code never changes when the implementation does.
 */
export interface Authenticator {
  readonly scheme: string
  authenticate(headers: RequestHeaders): Promise<Principal>
}

export const AuthenticatorContract = define.contract<Authenticator>('authenticator')

/** Implementation-specific settings taken from the site configuration (JSON). */
export const AuthOptions = define.input<Readonly<Record<string, unknown>>>('auth-options')

export const SiteAuth = define.binding('site-auth', AuthenticatorContract, {
  metadata: { displayName: 'Site authenticator' },
})

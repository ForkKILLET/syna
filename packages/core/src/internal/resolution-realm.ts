import type { ResolutionRealm } from './runtime-model.js'

export const PUBLIC_REALM: ResolutionRealm = Object.freeze({
  kind: 'public',
  id: 'public',
})

/**
 * A Service-owned Entry resolves its roots with the authority of the owning
 * Service: exact and range roots may select revisions from that Service's
 * private transitive closure. Contract, auto, selector and all discovery
 * remain public. Realm identity depends only on the owner revision, so plan
 * templates for the same owner are shared.
 */
export function privateEntryRealm(
  ownerKey: string,
  closureKeys: ReadonlySet<string>,
): ResolutionRealm {
  return Object.freeze({
    kind: 'private-entry',
    id: `private-entry:${ownerKey}`,
    ownerKey,
    closureKeys,
  })
}

export function realmAllows(realm: ResolutionRealm, revisionKey: string, admitted: boolean): boolean {
  if (admitted) return true
  return realm.kind === 'private-entry' && realm.closureKeys.has(revisionKey)
}

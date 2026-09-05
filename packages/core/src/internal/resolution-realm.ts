import type { EntryDescriptor, ServiceRevision } from '../descriptors.js'
import type { ResolutionRealm } from './runtime-model.js'
import { stableJson, unwrapDependency } from './runtime-utils.js'

export const PUBLIC_REALM: ResolutionRealm = Object.freeze({
  kind: 'public',
  id: 'public',
})

/**
 * A Service-owned Entry may expose exact private roots declared by that Entry.
 * Contract, auto, selector, all and range resolution remain public by design.
 */
export function privateEntryRealm(
  owner: ServiceRevision,
  dependencySite: string,
  entry: EntryDescriptor,
): ResolutionRealm {
  const exactRoots = Object.entries(entry.requires)
    .map(([key, dependency]) => {
      const resolved = unwrapDependency(dependency)
      return resolved.kind === 'service-revision'
        ? [key, resolved.key] as const
        : undefined
    })
    .filter((item): item is readonly [string, string] => item !== undefined)

  return Object.freeze({
    kind: 'private-entry',
    id: `private-entry:${owner.key}:${dependencySite}:${stableJson(exactRoots)}`,
  })
}

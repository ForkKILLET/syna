import type {
  Contract,
  Dependency,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { compareVersions } from '../semver.js'

export interface RevisionLike {
  readonly key: string
  readonly version: string
  readonly family: { readonly id: string }
  readonly provides: readonly Contract[]
}

export function isServiceRevision(value: unknown): value is ServiceRevision {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'service-revision'
}

export function unwrapDependency(
  input: Dependency,
): Exclude<Dependency, { kind: 'forward-dependency' }> {
  let current: Dependency = input
  const seen = new Set<unknown>()

  if (typeof current !== 'object' || current === null) {
    throw new SynaError('INVALID_DESCRIPTOR', 'A dependency must be a descriptor object.')
  }
  while (current.kind === 'forward-dependency') {
    if (seen.has(current)) {
      throw new SynaError(
        'INVALID_DESCRIPTOR',
        'A forward dependency descriptor resolves to itself.',
      )
    }
    seen.add(current)
    current = current.get()
    if (typeof current !== 'object' || current === null) {
      throw new SynaError('INVALID_DESCRIPTOR', 'A forward dependency resolved to a non-descriptor value.')
    }
  }

  return current as Exclude<Dependency, { kind: 'forward-dependency' }>
}

export function providesContract(
  revision: RevisionLike,
  contract: Pick<Contract, 'id'>,
): boolean {
  return revision.provides.some(provided => provided.id === contract.id)
}

export function dependencyIdentity(input: Dependency): string {
  const dependency = unwrapDependency(input)
  switch (dependency.kind) {
    case 'service-revision': return `service:${dependency.key}`
    case 'service-range': return `range:${dependency.family.id}@${dependency.range}#${dependency.origin.key}`
    case 'contract': return `strict-contract:${dependency.id}`
    case 'input': return `input:${dependency.id}`
    case 'binding': return `binding:${dependency.id}:${dependency.contract.id}`
    case 'auto-implementation': return `auto:${dependency.contract.id}`
    case 'all-implementations': return `all:${dependency.contract.id}`
    case 'entry': return `entry:${dependency.id}`
    default:
      throw new SynaError(
        'INVALID_DESCRIPTOR',
        `Unknown dependency descriptor kind ${String((dependency as { kind?: unknown }).kind)}.`,
      )
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Compact, deterministic digest (two mixed 32-bit hashes plus the length). It
 * keeps signatures and plan-template keys small; wherever a collision could
 * matter the full text is verified separately, so a collision costs a cache
 * miss or an unreported drift, never a wrong plan.
 */
export function compactDigest(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}:${text.length}`
}

/**
 * Structural identity only. Human-facing metadata is intentionally excluded.
 * The setup function takes part through the digest of its source text: two
 * physical copies of one revision whose setup bodies differ are two
 * definitions, not one that silently wins. Captured state and native functions
 * are invisible to this comparison (documented limit).
 */
export function revisionStructuralSignature(revision: ServiceRevision): string {
  const dependencies = Object.entries(revision.requires)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, dependency]) => `${key}=${dependencyIdentity(dependency)}`)
    .join(';')
  const contracts = revision.provides.map(contract => contract.id).sort().join(',')
  return [
    revision.key,
    `uniqueWithin=${revision.family.uniqueWithin}`,
    `eager=${revision.eager}`,
    `failure=${stableJson(revision.failure)}`,
    `deadline=${String(revision.setupDeadlineMs)}`,
    `provides=${contracts}`,
    `deps=${dependencies}`,
    `setup=${compactDigest(String(revision.setup))}`,
  ].join('|')
}

export function revisionMetadataSignature(revision: ServiceRevision): string {
  return stableJson({
    family: revision.family.metadata,
    revision: revision.metadata,
  })
}

/** Returns a warning for metadata drift; throws for structural conflicts. */
export function assertEquivalentRevisionDefinitions(
  canonical: ServiceRevision,
  received: ServiceRevision,
): string | undefined {
  if (canonical === received) return undefined
  const expected = revisionStructuralSignature(canonical)
  const actual = revisionStructuralSignature(received)
  if (expected !== actual) {
    throw new SynaError(
      'DUPLICATE_DEFINITION',
      `Service Revision ${received.key} has conflicting structural manifests.`,
      { revision: received.key, expected, actual },
    )
  }

  const expectedMetadata = revisionMetadataSignature(canonical)
  const actualMetadata = revisionMetadataSignature(received)
  return expectedMetadata === actualMetadata
    ? undefined
    : `Service Revision ${received.key} was loaded with different non-semantic metadata.`
}

/** Family id ascending, then version descending. */
export function compareRevisionIdentity(
  left: RevisionLike,
  right: RevisionLike,
): number {
  const familyComparison = left.family.id.localeCompare(right.family.id)
  if (familyComparison !== 0) return familyComparison
  return compareVersions(right.version, left.version)
}

/** Prefer an already active exact revision, then the highest compatible version. */
export function defaultVersionOrder<T extends RevisionLike>(
  candidates: readonly T[],
  parentActiveRevisionKeys: ReadonlySet<string>,
): readonly T[] {
  return [...candidates].sort((left, right) => {
    const leftInherited = parentActiveRevisionKeys.has(left.key) ? 1 : 0
    const rightInherited = parentActiveRevisionKeys.has(right.key) ? 1 : 0
    if (leftInherited !== rightInherited) return rightInherited - leftInherited
    return compareVersions(right.version, left.version)
  })
}

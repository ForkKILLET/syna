import type {
  Contract,
  Dependency,
  DependencyRef,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { compareVersions } from '../semver.js'

export function createDependencyRef<T>(
  load: () => Promise<T>,
  preload: () => void,
): DependencyRef<T> {
  return Object.freeze({ load, preload })
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

  while (current.kind === 'forward-dependency') {
    if (seen.has(current)) {
      throw new SynaError(
        'INVALID_DESCRIPTOR',
        'A forward dependency descriptor resolves to itself.',
      )
    }
    seen.add(current)
    current = current.get()
  }

  return current as Exclude<Dependency, { kind: 'forward-dependency' }>
}

export function providesContract(
  revision: ServiceRevision,
  contract: Contract,
): boolean {
  return revision.provides.some(provided => provided.id === contract.id)
}

export function dependencyIdentity(input: Dependency): string {
  const dependency = unwrapDependency(input)
  switch (dependency.kind) {
    case 'service-revision': return `service:${dependency.key}`
    case 'service-range': return `range:${dependency.family.id}@${dependency.range}`
    case 'contract': return `strict-contract:${dependency.id}`
    case 'input': return `input:${dependency.id}`
    case 'binding': return `binding:${dependency.id}:${dependency.contract.id}`
    case 'auto-implementation': return `auto:${dependency.contract.id}`
    case 'implementation-selector': return `selector:${dependency.contract.id}`
    case 'all-implementations': return `all:${dependency.contract.id}`
    case 'entry': return `entry:${dependency.id}`
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
  return JSON.stringify(value)
}

/** Structural identity only. Human-facing metadata is intentionally excluded. */
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
    `provides=${contracts}`,
    `deps=${dependencies}`,
  ].join('|')
}

export function revisionMetadataSignature(revision: ServiceRevision): string {
  return stableJson({
    family: revision.family.metadata,
    revision: revision.metadata,
  })
}

export function assertEquivalentRevisionDefinitions(
  canonical: ServiceRevision,
  received: ServiceRevision,
): string | undefined {
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

export function compareRevisionIdentity(
  left: ServiceRevision,
  right: ServiceRevision,
): number {
  const familyComparison = left.family.id.localeCompare(right.family.id)
  if (familyComparison !== 0) return familyComparison
  return compareVersions(right.version, left.version)
}

/** Prefer an already active exact revision, then the highest compatible version. */
export function defaultVersionOrder(
  candidates: readonly ServiceRevision[],
  parentActiveRevisionKeys: ReadonlySet<string>,
): readonly ServiceRevision[] {
  return [...candidates].sort((left, right) => {
    const leftInherited = parentActiveRevisionKeys.has(left.key) ? 1 : 0
    const rightInherited = parentActiveRevisionKeys.has(right.key) ? 1 : 0
    if (leftInherited !== rightInherited) return rightInherited - leftInherited
    return compareVersions(right.version, left.version)
  })
}

export function distinctImplementationFamilies(
  candidates: readonly ServiceRevision[],
): readonly string[] {
  return [...new Set(candidates.map(candidate => candidate.family.id))].sort()
}

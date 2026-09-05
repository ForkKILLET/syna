import type {
  AvailableImplementationCandidate,
  CandidateRef,
  Contract,
  ImplementationCandidate,
  ImplementationDescriptor,
  PersistentImplementationRef,
  RuntimePolicy,
  ServiceRevision,
} from '../descriptors.js'
import type { DiagnosticCode } from '../errors.js'
import { SynaError } from '../errors.js'
import { caretRange, satisfiesVersion } from '../semver.js'
import type { CompiledService, InternalCandidateRef } from './runtime-model.js'
import { compareRevisionIdentity, providesContract } from './identity.js'

export interface CandidateAvailabilityInput {
  readonly status: 'available' | 'unavailable'
  readonly code?: DiagnosticCode
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface CandidateIndexOptions<C extends Contract<any>> {
  readonly contract: C
  readonly sourceSlotId: string
  readonly revisions: readonly CompiledService[]
  readonly availabilityByRevision?: ReadonlyMap<string, CandidateAvailabilityInput>
  readonly sitePrefix: string
  readonly parentActiveRevisionKeys: ReadonlySet<string>
}

/**
 * Immutable read-only directory over the public admission set. It centralizes
 * candidate identity, durable-reference resolution, policy-order validation and
 * collection-local candidate views so `C.all`, the compatibility selector and
 * the catalog share one implementation.
 */
export class ImplementationDirectory {
  private readonly byFamily = new Map<string, readonly CompiledService[]>()

  constructor(
    private readonly admitted: readonly CompiledService[],
    private readonly policy: RuntimePolicy,
  ) {
    const mutable = new Map<string, CompiledService[]>()
    for (const revision of admitted) {
      const list = mutable.get(revision.family.id) ?? []
      list.push(revision)
      mutable.set(revision.family.id, list)
    }
    for (const [familyId, revisions] of mutable) {
      this.byFamily.set(familyId, Object.freeze([...revisions].sort(compareRevisionIdentity)))
    }
  }

  candidatesForImplementationId(implementationId: string): readonly CompiledService[] {
    return this.byFamily.get(implementationId) ?? Object.freeze([])
  }

  candidatesForContract(contract: Pick<Contract, 'id'>): readonly CompiledService[] {
    return Object.freeze(
      this.admitted
        .filter(revision => providesContract(revision, contract))
        .sort(compareRevisionIdentity),
    )
  }

  implementations<C extends Contract<any>>(contract: C): readonly ImplementationDescriptor<C>[] {
    if (typeof contract !== 'object' || contract === null || contract.kind !== 'contract') {
      throw new SynaError('INVALID_DESCRIPTOR', 'catalog.implementations() expects a Contract descriptor.')
    }
    return Object.freeze(
      this.candidatesForContract(contract).map(revision => this.describe<C>(contract, revision)),
    )
  }

  revisions(familyId: string): readonly string[] {
    return Object.freeze(this.candidatesForImplementationId(familyId).map(revision => revision.version))
  }

  resolveCatalog<C extends Contract<any>>(ref: PersistentImplementationRef<C>): ImplementationDescriptor<C> {
    if (typeof ref !== 'object' || ref === null || ref.kind !== 'persistent-implementation-ref') {
      throw new SynaError('INVALID_DESCRIPTOR', 'catalog.resolve() expects a persistent implementation reference.')
    }
    const contract = { id: ref.contractId }
    const revision = this.resolvePersistentRevision(
      contract,
      this.candidatesForContract(contract),
      ref,
      `catalog:${ref.contractId}:${ref.implementationId}`,
      new Set(),
    )
    return this.describe<C>(contract, revision, ref)
  }

  createIndex<C extends Contract<any>>(options: CandidateIndexOptions<C>): CandidateIndex<C> {
    return new CandidateIndex(this, options)
  }

  describe<C extends Contract<any>>(
    contract: Pick<Contract, 'id'>,
    revision: CompiledService,
    persistentRef?: PersistentImplementationRef<C>,
  ): ImplementationDescriptor<C> {
    return Object.freeze({
      contractId: contract.id,
      familyId: revision.family.id,
      version: revision.version,
      eager: revision.eager,
      familyMetadata: revision.family.metadata,
      revisionMetadata: revision.metadata,
      persistentRef: persistentRef ?? Object.freeze({
        kind: 'persistent-implementation-ref' as const,
        contractId: contract.id,
        implementationId: revision.family.id,
        version: caretRange(revision.version),
      }) as PersistentImplementationRef<C>,
    })
  }

  resolvePersistentRevision(
    contract: Pick<Contract, 'id'>,
    allowed: readonly CompiledService[],
    ref: PersistentImplementationRef<any>,
    site: string,
    parentActiveRevisionKeys: ReadonlySet<string>,
  ): CompiledService {
    if (ref.contractId !== contract.id) {
      throw new SynaError(
        'INCOMPATIBLE_IMPLEMENTATION',
        `Implementation reference for ${ref.contractId} cannot be used with ${contract.id}.`,
        { contract: contract.id, reference: ref.contractId },
      )
    }
    const allowedKeys = new Set(allowed.map(candidate => candidate.key))
    const family = this.candidatesForImplementationId(ref.implementationId)
    if (family.length === 0) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        `Implementation family ${ref.implementationId} is not admitted by this Runtime; no supplier substitution is attempted.`,
        { contract: contract.id, implementation: ref.implementationId, version: ref.version },
      )
    }
    const matching = family
      .filter(candidate => allowedKeys.has(candidate.key))
      .filter(candidate => providesContract(candidate, contract))
      .filter(candidate => satisfiesVersion(candidate.version, ref.version))
    if (matching.length === 0) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        `No ${ref.implementationId} candidate for ${contract.id} satisfies ${ref.version}.`,
        {
          contract: contract.id,
          implementation: ref.implementationId,
          version: ref.version,
          available: family.map(candidate => candidate.version),
        },
      )
    }
    const ordered = this.orderCandidates(
      matching,
      revisions => this.policy.orderVersionCandidates(
        matching[0]!.family,
        revisions,
        { site, parentActiveRevisionKeys },
      ),
      site,
    )
    return ordered[0]!
  }

  /**
   * Runs a policy ordering over the public descriptors of `candidates` and maps
   * the result back. A policy must return every candidate exactly once; a
   * policy exception propagates unchanged (it is a bug, not unsatisfiability).
   */
  orderCandidates(
    candidates: readonly CompiledService[],
    order: (revisions: readonly ServiceRevision[]) => readonly ServiceRevision[],
    site: string,
  ): readonly CompiledService[] {
    const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]))
    const ordered = order(candidates.map(candidate => candidate.source))
    if (!Array.isArray(ordered)) {
      throw new SynaError(
        'INVALID_DESCRIPTOR',
        `Resolution policy must return an array of candidates at ${site}.`,
        { site },
      )
    }
    const originalKeys = [...byKey.keys()].sort()
    const orderedKeys = ordered.map(candidate => candidate?.key).sort()
    if (
      originalKeys.length !== orderedKeys.length
      || originalKeys.some((key, index) => key !== orderedKeys[index])
    ) {
      throw new SynaError(
        'INVALID_DESCRIPTOR',
        `Resolution policy must return every candidate exactly once at ${site}.`,
        { site, original: originalKeys, ordered: orderedKeys },
      )
    }
    return ordered.map(candidate => byKey.get(candidate.key)!)
  }
}

/** One canonical collection-local view over exact candidate revisions. */
export class CandidateIndex<C extends Contract<any>> {
  readonly candidates: readonly ImplementationCandidate<C>[]
  private readonly byRevisionKey = new Map<string, ImplementationCandidate<C>>()

  constructor(
    private readonly directory: ImplementationDirectory,
    private readonly options: CandidateIndexOptions<C>,
  ) {
    const values: ImplementationCandidate<C>[] = []
    for (const revision of options.revisions) {
      const availability = options.availabilityByRevision?.get(revision.key)
      const normalizedAvailability = availability?.status === 'unavailable'
        ? Object.freeze({
            status: 'unavailable' as const,
            code: availability.code ?? 'UNKNOWN_ERROR',
            message: availability.message ?? 'Implementation is unavailable.',
            details: availability.details ?? Object.freeze({}),
          })
        : Object.freeze({ status: 'available' as const })
      const candidate = Object.freeze({
        ...directory.describe<C>(options.contract, revision),
        ref: this.createRef(revision),
        availability: normalizedAvailability,
      }) as ImplementationCandidate<C>
      values.push(candidate)
      this.byRevisionKey.set(revision.key, candidate)
    }
    this.candidates = Object.freeze(values)
  }

  resolve(ref: PersistentImplementationRef<C>): ImplementationCandidate<C> {
    if (typeof ref !== 'object' || ref === null || ref.kind !== 'persistent-implementation-ref') {
      throw new SynaError('INVALID_DESCRIPTOR', 'resolve() expects a persistent implementation reference.')
    }
    const selected = this.directory.resolvePersistentRevision(
      this.options.contract,
      this.options.revisions,
      ref,
      `${this.options.sitePrefix}/persistent:${ref.implementationId}`,
      this.options.parentActiveRevisionKeys,
    )
    return this.byRevisionKey.get(selected.key)!
  }

  normalize(
    input: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>,
  ): ImplementationCandidate<C> {
    if (typeof input !== 'object' || input === null) {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected a candidate, candidate ref or persistent ref.')
    }
    if ('kind' in input && input.kind === 'persistent-implementation-ref') {
      return this.resolve(input)
    }

    const ref = ('ref' in input ? input.ref : input) as Partial<InternalCandidateRef>
    if (ref.kind !== 'candidate-ref' || typeof ref.sourceSlotId !== 'string') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected a CandidateRef created by this Runtime.')
    }
    if (ref.sourceSlotId !== this.options.sourceSlotId) {
      throw new SynaError(
        'CONSTRAINT_VIOLATION',
        'CandidateRef belongs to another implementation collection.',
        {
          expectedSourceSlot: this.options.sourceSlotId,
          receivedSourceSlot: ref.sourceSlotId,
        },
      )
    }
    const candidate = this.byRevisionKey.get(ref.revisionKey ?? '')
    if (!candidate) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        'Candidate does not belong to this implementation collection.',
        { revision: ref.revisionKey },
      )
    }
    return candidate
  }

  requireAvailable(
    input: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>,
  ): AvailableImplementationCandidate<C> {
    const candidate = this.normalize(input)
    if (candidate.availability.status === 'unavailable') {
      throw new SynaError(
        'UNAVAILABLE_IMPLEMENTATION',
        `${candidate.familyId}@${candidate.version} is unavailable: ${candidate.availability.message}`,
        {
          candidate: `${candidate.familyId}@${candidate.version}`,
          reason: candidate.availability,
        },
      )
    }
    return candidate as AvailableImplementationCandidate<C>
  }

  revisionKey(candidate: ImplementationCandidate<C>): string {
    return (candidate.ref as InternalCandidateRef).revisionKey
  }

  private createRef(revision: CompiledService): InternalCandidateRef {
    return Object.freeze({
      kind: 'candidate-ref',
      contract: this.options.contract,
      familyId: revision.family.id,
      version: revision.version,
      sourceSlotId: this.options.sourceSlotId,
      revisionKey: revision.key,
    }) as InternalCandidateRef
  }
}

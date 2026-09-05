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
import { SynaError } from '../errors.js'
import { normalizeVersion, satisfiesVersion } from '../semver.js'
import type { InternalCandidateRef } from './runtime-model.js'
import {
  compareRevisionIdentity,
  providesContract,
} from './runtime-utils.js'

export interface CandidateAvailabilityInput {
  readonly status: 'available' | 'unavailable'
  readonly code?: ImplementationCandidate['availability'] extends infer A
    ? A extends { readonly status: 'unavailable'; readonly code: infer Code }
      ? Code
      : never
    : never
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface CandidateIndexOptions<C extends Contract<any>> {
  readonly contract: C
  readonly sourceSlotId: string
  readonly revisions: readonly ServiceRevision[]
  readonly availabilityByRevision?: ReadonlyMap<string, CandidateAvailabilityInput>
  readonly sitePrefix: string
  readonly parentActiveRevisionKeys: ReadonlySet<string>
}

/**
 * Immutable directory over the Runtime's public admission set. It centralizes
 * candidate identity, durable-reference resolution and view-local validation.
 */
export class ImplementationDirectory {
  private readonly byFamily = new Map<string, readonly ServiceRevision[]>()

  constructor(
    private readonly admittedRevisions: readonly ServiceRevision[],
    private readonly policy: RuntimePolicy,
  ) {
    const mutable = new Map<string, ServiceRevision[]>()
    for (const revision of admittedRevisions) {
      const list = mutable.get(revision.family.id) ?? []
      list.push(revision)
      mutable.set(revision.family.id, list)
    }
    for (const [familyId, revisions] of mutable) {
      this.byFamily.set(
        familyId,
        Object.freeze([...revisions].sort(compareRevisionIdentity)),
      )
    }
  }

  candidatesForImplementationId(implementationId: string): readonly ServiceRevision[] {
    return this.byFamily.get(implementationId) ?? Object.freeze([])
  }

  candidatesForContract<C extends Contract<any>>(contract: C): readonly ServiceRevision[] {
    return Object.freeze(
      this.admittedRevisions
        .filter(revision => providesContract(revision, contract))
        .sort(compareRevisionIdentity),
    )
  }

  implementations<C extends Contract<any>>(
    contract: C,
  ): readonly ImplementationDescriptor<C>[] {
    return Object.freeze(
      this.candidatesForContract(contract)
        .map(revision => this.describe<C>(contract, revision)),
    )
  }

  resolveCatalog<C extends Contract<any>>(
    ref: PersistentImplementationRef<C>,
  ): ImplementationDescriptor<C> {
    const contract = { id: ref.contractId } as C
    const revision = this.resolvePersistentRevision(
      contract,
      this.admittedRevisions.filter(candidate => providesContract(candidate, contract)),
      ref,
      `catalog:${ref.contractId}:${ref.implementationId}`,
      new Set(),
    )
    return this.describe(contract, revision, ref)
  }

  createIndex<C extends Contract<any>>(
    options: CandidateIndexOptions<C>,
  ): CandidateIndex<C> {
    return new CandidateIndex(this, options)
  }

  describe<C extends Contract<any>>(
    contract: Pick<C, 'id'>,
    revision: ServiceRevision,
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
        version: `^${normalizeVersion(revision.version)}`,
      }) as PersistentImplementationRef<C>,
    })
  }

  resolvePersistentRevision<C extends Contract<any>>(
    contract: Pick<C, 'id'>,
    allowed: readonly ServiceRevision[],
    ref: PersistentImplementationRef<C>,
    site: string,
    parentActiveRevisionKeys: ReadonlySet<string>,
  ): ServiceRevision {
    this.assertPersistentContract(contract, ref)
    const allowedKeys = new Set(allowed.map(candidate => candidate.key))
    const matching = this.candidatesForImplementationId(ref.implementationId)
      .filter(candidate => allowedKeys.has(candidate.key))
      .filter(candidate => providesContract(candidate, contract as Contract))
      .filter(candidate => satisfiesVersion(candidate.version, ref.version))
    if (matching.length === 0) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        `No ${ref.implementationId} candidate for ${contract.id} satisfies ${ref.version}.`,
        {
          contract: contract.id,
          implementation: ref.implementationId,
          version: ref.version,
        },
      )
    }
    const ordered = this.validateOrder(
      matching,
      this.policy.orderVersionCandidates(
        matching[0]!.family,
        matching,
        { site, parentActiveRevisionKeys },
      ),
      site,
    )
    return ordered[0]!
  }

  validateOrder(
    original: readonly ServiceRevision[],
    ordered: readonly ServiceRevision[],
    site: string,
  ): readonly ServiceRevision[] {
    const originalKeys = [...original].map(candidate => candidate.key).sort()
    const orderedKeys = [...ordered].map(candidate => candidate.key).sort()
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
    return ordered
  }

  private assertPersistentContract(
    contract: Pick<Contract, 'id'>,
    ref: PersistentImplementationRef<any>,
  ): void {
    if (ref.contractId !== contract.id) {
      throw new SynaError(
        'INCOMPATIBLE_IMPLEMENTATION',
        `Implementation reference for ${ref.contractId} cannot be used with ${contract.id}.`,
      )
    }
  }
}

/** One canonical selector/set-local view over exact candidate revisions. */
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
        ...directory.describe(options.contract, revision),
        ref: this.createRef(revision),
        availability: normalizedAvailability,
      }) as unknown as ImplementationCandidate<C>
      values.push(candidate)
      this.byRevisionKey.set(revision.key, candidate)
    }
    this.candidates = Object.freeze(values)
  }

  resolve(ref: PersistentImplementationRef<C>): ImplementationCandidate<C> {
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
    if ('kind' in input && input.kind === 'persistent-implementation-ref') {
      return this.resolve(input)
    }

    const ref = ('ref' in input ? input.ref : input) as InternalCandidateRef
    if (ref.sourceSlotId !== this.options.sourceSlotId) {
      throw new SynaError(
        'CONSTRAINT_VIOLATION',
        'CandidateRef belongs to another implementation view.',
        {
          expectedSourceSlot: this.options.sourceSlotId,
          receivedSourceSlot: ref.sourceSlotId,
        },
      )
    }
    const candidate = this.byRevisionKey.get(ref.revisionKey)
    if (!candidate) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        'Candidate does not belong to this implementation view.',
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

  private createRef(revision: ServiceRevision): InternalCandidateRef {
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

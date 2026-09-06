import type {
  CandidateRef,
  Contract,
  ImplementationCandidate,
  ImplementationDescriptor,
  ImplementationRef,
  RuntimeEvent,
  RuntimePolicy,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { createImplementationRef, familyIdOf, isLegacyImplementationRef, normalizeImplementationRef } from '../definition.js'
import { caretRange, satisfiesVersion } from '../semver.js'
import { PolicyContext, type CompiledService, type InternalCandidateRef } from './runtime-model.js'
import { compareRevisionIdentity, providesContract } from './identity.js'

export interface CandidateIndexOptions<C extends Contract<any>> {
  readonly contract: C
  readonly sourceSlotId: string
  readonly revisions: readonly CompiledService[]
  readonly sitePrefix: string
  readonly parentActiveRevisionKeys: ReadonlySet<string>
}

/**
 * Immutable read-only directory over the public admission set. It centralizes
 * candidate identity, durable-reference resolution, policy-order validation and
 * collection-local candidate views so `C.all` and the catalog share one
 * implementation.
 */
export class ImplementationDirectory {
  private readonly byFamily = new Map<string, readonly CompiledService[]>()

  constructor(
    private readonly admitted: readonly CompiledService[],
    private readonly policy: RuntimePolicy,
    private readonly onEvent: (event: RuntimeEvent) => void = () => undefined,
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

  candidatesForFamily(familyId: string): readonly CompiledService[] {
    return this.byFamily.get(familyId) ?? Object.freeze([])
  }

  /**
   * The family a caller's implementation reference names. A reference in the
   * 0.5 serialized form (family under the old key, or parsed from such a
   * document) is accepted and reported once per read as `legacy-implementation-ref`.
   */
  familyOf(ref: ImplementationRef, site: string): string {
    const familyId = familyIdOf(ref)
    if (isLegacyImplementationRef(ref)) {
      this.onEvent({ type: 'legacy-implementation-ref', contractId: ref.contractId, familyId, version: ref.version, site })
    }
    return familyId
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
    return Object.freeze(this.candidatesForFamily(familyId).map(revision => revision.version))
  }

  resolveCatalog<C extends Contract<any>>(ref: ImplementationRef<C>): ImplementationDescriptor<C> {
    if (typeof ref !== 'object' || ref === null || ref.kind !== 'persistent-implementation-ref') {
      throw new SynaError('INVALID_DESCRIPTOR', 'catalog.resolve() expects a persistent implementation reference.')
    }
    const contract = { id: ref.contractId }
    const revision = this.resolvePersistentRevision(
      contract,
      this.candidatesForContract(contract),
      ref,
      `catalog:${ref.contractId}:${familyIdOf(ref)}`,
      new Set(),
    )
    return this.describe<C>(contract, revision, normalizeImplementationRef(ref))
  }

  createIndex<C extends Contract<any>>(options: CandidateIndexOptions<C>): CandidateIndex<C> {
    return new CandidateIndex(this, options)
  }

  describe<C extends Contract<any>>(
    contract: Pick<Contract, 'id'>,
    revision: CompiledService,
    persistentRef?: ImplementationRef<C>,
  ): ImplementationDescriptor<C> {
    return Object.freeze({
      contractId: contract.id,
      familyId: revision.family.id,
      version: revision.version,
      eager: revision.eager,
      familyMetadata: revision.family.metadata,
      revisionMetadata: revision.metadata,
      persistentRef: persistentRef ?? createImplementationRef<C>(contract, revision.family.id, caretRange(revision.version)),
    })
  }

  resolvePersistentRevision(
    contract: Pick<Contract, 'id'>,
    allowed: readonly CompiledService[],
    ref: ImplementationRef<any>,
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
    const familyId = this.familyOf(ref, site)
    const family = this.candidatesForFamily(familyId)
    if (family.length === 0) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        `Implementation family ${familyId} is not admitted by this Runtime; no supplier substitution is attempted.`,
        { contract: contract.id, implementation: familyId, version: ref.version },
      )
    }
    const matching = family
      .filter(candidate => allowedKeys.has(candidate.key))
      .filter(candidate => providesContract(candidate, contract))
      .filter(candidate => satisfiesVersion(candidate.version, ref.version))
    if (matching.length === 0) {
      throw new SynaError(
        'MISSING_IMPLEMENTATION',
        `No ${familyId} candidate for ${contract.id} satisfies ${ref.version}.`,
        {
          contract: contract.id,
          implementation: familyId,
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
        new PolicyContext(site, parentActiveRevisionKeys),
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
      const candidate = Object.freeze({
        ...directory.describe<C>(options.contract, revision),
        ref: this.createRef(revision),
        availability: Object.freeze({ status: 'available' as const }),
      }) as ImplementationCandidate<C>
      values.push(candidate)
      this.byRevisionKey.set(revision.key, candidate)
    }
    this.candidates = Object.freeze(values)
  }

  resolve(ref: ImplementationRef<C>): ImplementationCandidate<C> {
    if (typeof ref !== 'object' || ref === null || ref.kind !== 'persistent-implementation-ref') {
      throw new SynaError('INVALID_DESCRIPTOR', 'resolve() expects a persistent implementation reference.')
    }
    const selected = this.directory.resolvePersistentRevision(
      this.options.contract,
      this.options.revisions,
      ref,
      `${this.options.sitePrefix}/persistent:${familyIdOf(ref)}`,
      this.options.parentActiveRevisionKeys,
    )
    return this.byRevisionKey.get(selected.key)!
  }

  normalize(
    input: ImplementationCandidate<C> | CandidateRef<C> | ImplementationRef<C>,
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
        'FRESH_CONSTRAINT_FAILED',
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

  /** The candidate this collection holds for `input` (a candidate, its CandidateRef or an ImplementationRef). */
  require(
    input: ImplementationCandidate<C> | CandidateRef<C> | ImplementationRef<C>,
  ): ImplementationCandidate<C> {
    return this.normalize(input)
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

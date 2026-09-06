import type {
  AnchoredEntry,
  CandidateRef,
  Contract,
  EntryCheck,
  EntryDescriptor,
  EnvHandle,
  ImplementationCandidate,
  ImplementationLease,
  ImplementationSelector,
  ImplementationSet,
  LoadOptions,
  ImplementationRef,
  ServiceRevision,
} from '../descriptors.js'
import type { CandidateAvailabilityInput, ImplementationDirectory } from './implementation-directory.js'
import type {
  AllPlanNode,
  CompiledService,
  ResolutionRealm,
  RuntimeSlot,
  SelectorPlanNode,
  SyntheticSlot,
} from './runtime-model.js'
import { withDeprecatedScope } from '../definition.js'
import { PUBLIC_REALM } from './resolution-realm.js'

/** The subset of Runtime behaviour the collection views need. */
export interface ImplementationViewHost {
  readonly directory: ImplementationDirectory
  readonly internalPackage: EntryDescriptor['package']
  activeRevisionKeys(envId: string): ReadonlySet<string>
  checkPlanOnly(
    anchorEnvId: string,
    descriptor: EntryDescriptor,
    realm: ResolutionRealm,
  ): Promise<EntryCheck>
  createAnchoredEntry<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    anchorEnvId: string,
    realm: ResolutionRealm,
  ): AnchoredEntry<E>
  executeStructured<Result>(env: EnvHandle, callback: () => Promise<Result> | Result): Promise<Result>
  loadSlot(slot: RuntimeSlot, options?: LoadOptions): Promise<unknown>
}

/**
 * Synthetic candidate Entries, one per (physical revision descriptor, Contract).
 * The Entry references the very descriptor it was made from, so the cache is
 * keyed by that object: a Runtime holding another physical copy of the same
 * revision key must never be handed an Entry pointing at the copy an earlier
 * Runtime in this process canonicalized (Runtime isolation, K01).
 */
const candidateEntryCache = new WeakMap<ServiceRevision<any>, Map<string, EntryDescriptor<{ implementation: ServiceRevision<any> }, {}>>>()

export function candidateEntry(
  host: ImplementationViewHost,
  contract: Contract,
  revision: CompiledService,
): EntryDescriptor<{ implementation: ServiceRevision<any> }, {}> {
  let byContract = candidateEntryCache.get(revision.source)
  if (!byContract) {
    byContract = new Map()
    candidateEntryCache.set(revision.source, byContract)
  }
  const existing = byContract.get(contract.id)
  if (existing) return existing
  const entry = Object.freeze(withDeprecatedScope({
    kind: 'entry' as const,
    package: host.internalPackage,
    id: `@syna/core/entry/candidate/${contract.id}/${revision.key}/v1`,
    apiVersion: 1,
    requires: Object.freeze({ implementation: revision.source }),
    parameters: Object.freeze({}),
    reuse: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
    metadata: Object.freeze({}),
  }))
  byContract.set(contract.id, entry)
  return entry
}

/**
 * Compatibility selector: candidates are pre-flighted as independent child
 * plans anchored at the owner Env; `open()` creates a child Env and therefore
 * requires the anchor to be Ready.
 */
export async function createSelector(
  host: ImplementationViewHost,
  node: SelectorPlanNode,
  slot: SyntheticSlot,
  anchorEnvId: string,
): Promise<ImplementationSelector<any>> {
  const availabilityByRevision = new Map<string, CandidateAvailabilityInput>()
  const anchoredEntryByRevision = new Map<string, AnchoredEntry<EntryDescriptor<{ implementation: ServiceRevision<any> }, {}>>>()

  for (const revision of node.candidates) {
    const entry = candidateEntry(host, node.contract, revision)
    const check = await host.checkPlanOnly(anchorEnvId, entry, PUBLIC_REALM)
    anchoredEntryByRevision.set(revision.key, host.createAnchoredEntry(entry, anchorEnvId, PUBLIC_REALM))
    availabilityByRevision.set(
      revision.key,
      check.ok
        ? Object.freeze({ status: 'available' as const })
        : Object.freeze({
            status: 'unavailable' as const,
            code: check.error.code,
            message: check.error.message,
            details: check.error.details,
          }),
    )
  }

  const index = host.directory.createIndex({
    contract: node.contract,
    sourceSlotId: slot.id,
    revisions: node.candidates,
    availabilityByRevision,
    sitePrefix: node.dependencySite,
    parentActiveRevisionKeys: host.activeRevisionKeys(anchorEnvId),
  })

  const openCandidate = async (
    input: ImplementationCandidate<any> | CandidateRef<any> | ImplementationRef<any>,
  ): Promise<ImplementationLease<any>> => {
    const candidate = index.requireAvailable(input)
    const anchoredEntry = anchoredEntryByRevision.get(index.revisionKey(candidate))!
    const candidateEnv = await anchoredEntry.enter()
    return Object.freeze({
      env: candidateEnv,
      implementation: candidateEnv.deps.implementation,
      dispose: () => candidateEnv.dispose(),
      [Symbol.asyncDispose]: () => candidateEnv.dispose(),
    })
  }

  const selector: ImplementationSelector<any> = {
    contract: node.contract,
    candidates: index.candidates,
    *[Symbol.iterator]() { yield* index.candidates },
    resolve: ref => index.resolve(ref),
    open: openCandidate,
    run: async (input, callback) => {
      const lease = await openCandidate(input)
      return host.executeStructured(lease.env, () => Promise.resolve(callback(lease.implementation, lease.env)))
    },
  }
  return Object.freeze(selector)
}

/** `C.all`: every candidate already has a canonical slot in the current Env. */
export function createImplementationSet(
  host: ImplementationViewHost,
  node: AllPlanNode,
  slot: SyntheticSlot,
  envId: string,
): ImplementationSet<any> {
  const slotByRevision = new Map<string, RuntimeSlot>()
  for (const revision of node.candidates) {
    slotByRevision.set(revision.key, slot.requires.get(revision.key)!)
  }
  const index = host.directory.createIndex({
    contract: node.contract,
    sourceSlotId: slot.id,
    revisions: node.candidates,
    sitePrefix: `all:${node.contract.id}`,
    parentActiveRevisionKeys: host.activeRevisionKeys(envId),
  })
  const implementationSet: ImplementationSet<any> = {
    contract: node.contract,
    candidates: index.candidates,
    *[Symbol.iterator]() { yield* index.candidates },
    resolve: ref => index.resolve(ref),
    load: async (input, options) => {
      const candidate = index.requireAvailable(input)
      return host.loadSlot(slotByRevision.get(index.revisionKey(candidate))!, options)
    },
  }
  return Object.freeze(implementationSet)
}

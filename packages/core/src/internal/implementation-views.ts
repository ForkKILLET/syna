import type {
  BoundEntry,
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
  PersistentImplementationRef,
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
  createBoundEntry<E extends EntryDescriptor<any, any>>(
    descriptor: E,
    anchorEnvId: string,
    realm: ResolutionRealm,
  ): BoundEntry<E>
  executeStructured<Result>(env: EnvHandle, callback: () => Promise<Result> | Result): Promise<Result>
  loadSlot(slot: RuntimeSlot, options?: LoadOptions): Promise<unknown>
}

const candidateEntryCache = new WeakMap<Contract, Map<string, EntryDescriptor<{ implementation: ServiceRevision<any> }, {}>>>()

export function candidateEntry(
  host: ImplementationViewHost,
  contract: Contract,
  revision: CompiledService,
): EntryDescriptor<{ implementation: ServiceRevision<any> }, {}> {
  let byRevision = candidateEntryCache.get(contract)
  if (!byRevision) {
    byRevision = new Map()
    candidateEntryCache.set(contract, byRevision)
  }
  const existing = byRevision.get(revision.key)
  if (existing) return existing
  const entry = Object.freeze({
    kind: 'entry' as const,
    package: host.internalPackage,
    id: `@syna/core/entry/candidate/${contract.id}/${revision.key}/v1`,
    apiVersion: 1,
    requires: Object.freeze({ implementation: revision.source }),
    parameters: Object.freeze({}),
    scope: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
    metadata: Object.freeze({}),
  })
  byRevision.set(revision.key, entry)
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
  const boundEntryByRevision = new Map<string, BoundEntry<EntryDescriptor<{ implementation: ServiceRevision<any> }, {}>>>()

  for (const revision of node.candidates) {
    const entry = candidateEntry(host, node.contract, revision)
    const check = await host.checkPlanOnly(anchorEnvId, entry, PUBLIC_REALM)
    boundEntryByRevision.set(revision.key, host.createBoundEntry(entry, anchorEnvId, PUBLIC_REALM))
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
    input: ImplementationCandidate<any> | CandidateRef<any> | PersistentImplementationRef<any>,
  ): Promise<ImplementationLease<any>> => {
    const candidate = index.requireAvailable(input)
    const boundEntry = boundEntryByRevision.get(index.revisionKey(candidate))!
    const candidateEnv = await boundEntry.enter()
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

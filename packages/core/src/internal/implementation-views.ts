import type { ImplementationSet, LoadOptions } from '../descriptors.js'
import type { ImplementationDirectory } from './implementation-directory.js'
import type { AllPlanNode, RuntimeSlot, SyntheticSlot } from './runtime-model.js'

/** The subset of Runtime behaviour the collection view needs. */
export interface ImplementationViewHost {
  readonly directory: ImplementationDirectory
  activeRevisionKeys(envId: string): ReadonlySet<string>
  loadSlot(slot: RuntimeSlot, options?: LoadOptions): Promise<unknown>
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
      const candidate = index.require(input)
      return host.loadSlot(slotByRevision.get(index.revisionKey(candidate))!, options)
    },
  }
  return Object.freeze(implementationSet)
}

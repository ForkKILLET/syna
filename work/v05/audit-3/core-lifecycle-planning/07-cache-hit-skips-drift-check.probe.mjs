// F-CL3 candidate: D40 (I-63) makes a physical copy of a revision whose setup body differs a
// DUPLICATE_DEFINITION. For a root-site reference this check runs inside the graph builder
// (`host.compiledExact(dependency)`), i.e. only on a COLD plan. `entryDefinitionSignature()` and the
// plan-template key identify the dependency by its key alone, so an Entry copy that references the
// drifted revision hits the template solved for the canonical copy and `compiledExact()` is never
// called: the drift is accepted silently and the canonical setup runs. Whether the drift is detected
// therefore depends on the cache state (order-dependent), and cached vs. uncached differ (R17).
// The same bypass applies to `check()`/`explain()` (they warm the cache) and to family
// `uniqueWithin` drift of a range's family.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, main, makeDefine, note, settle } from './_harness.mjs'

function fixtures() {
  const define = makeDefine('audit3.drift')
  const Canonical = makeDefine('audit3.drift.storage').service('storage', { setup: () => ({ flavour: 'canonical' }) })
  const Drifted = makeDefine('audit3.drift.storage').service('storage', { setup: () => ({ flavour: 'drifted' }) })
  const EntryCanonical = define.entry('main', { requires: { storage: Canonical } })
  const EntryDrifted = define.entry('main', { requires: { storage: Drifted } })
  return { Canonical, Drifted, EntryCanonical, EntryDrifted }
}

await main(async () => {
  const { Canonical, Drifted, EntryCanonical, EntryDrifted } = fixtures()
  check('the two copies have the same key and differ structurally (setup body)', Canonical.key === Drifted.key && String(Canonical.setup) !== String(Drifted.setup))

  // Cold: the drifted reference is refused (R20 behaviour, D40).
  const cold = createRuntime({ services: [Canonical] })
  const coldOutcome = await settle(cold.enter(EntryDrifted))
  check('cold plan: an Entry referencing the drifted copy is DUPLICATE_DEFINITION', coldOutcome.status === 'rejected' && coldOutcome.error.code === 'DUPLICATE_DEFINITION', coldOutcome.status === 'rejected' ? coldOutcome.error.code : 'fulfilled')
  await cold.dispose()

  // Warm: the canonical Entry copy (same id, same signature) planned first, then the drifted copy.
  const warm = createRuntime({ services: [Canonical] })
  const canonicalEnv = await warm.enter(EntryCanonical)
  await canonicalEnv.dispose()
  const before = warm.inspect().planCache
  const warmOutcome = await settle(warm.enter(EntryDrifted))
  const after = warm.inspect().planCache
  note('warm plan of the drifted copy', { status: warmOutcome.status, code: warmOutcome.error?.code, cacheHits: after.hits - before.hits })
  check('warm plan: the drifted copy is still DUPLICATE_DEFINITION (cache must not change the diagnosis, R17/D40)', warmOutcome.status === 'rejected' && warmOutcome.error.code === 'DUPLICATE_DEFINITION', warmOutcome.status === 'rejected' ? warmOutcome.error.code : 'fulfilled')
  if (warmOutcome.status === 'fulfilled') {
    const instance = await warmOutcome.value.deps.storage.load()
    note('which setup ran for the drifted reference', instance)
    check('the drifted reference silently ran the canonical setup', instance.flavour === 'canonical', instance)
    await warmOutcome.value.dispose()
  }
  await warm.dispose()

  // check() warms the cache too: a plan-only call with the canonical copy hides the drift for a later enter().
  const viaCheck = createRuntime({ services: [Canonical] })
  const checked = await viaCheck.check(EntryCanonical)
  check('check() of the canonical copy plans fine', checked.ok)
  const afterCheck = await settle(viaCheck.enter(EntryDrifted))
  check('after check() of the canonical copy, entering the drifted copy is still DUPLICATE_DEFINITION', afterCheck.status === 'rejected' && afterCheck.error.code === 'DUPLICATE_DEFINITION', afterCheck.status === 'rejected' ? afterCheck.error.code : 'fulfilled')
  if (afterCheck.status === 'fulfilled') await afterCheck.value.dispose()
  await viaCheck.dispose()

  // Control: with the template cache effectively disabled by churn (maxEntries: 1 and another Entry in between)
  // the drift is caught again, i.e. the diagnosis depends on cache state.
  const churn = createRuntime({ services: [Canonical], planCache: { maxEntries: 1 } })
  const other = makeDefine('audit3.drift.other').entry('other', { requires: { storage: Canonical } })
  const env1 = await churn.enter(EntryCanonical); await env1.dispose()
  const env2 = await churn.enter(other); await env2.dispose() // evicts the 'main' template
  const churned = await settle(churn.enter(EntryDrifted))
  check('after eviction the drifted copy is DUPLICATE_DEFINITION again (diagnosis is cache-state dependent)', churned.status === 'rejected' && churned.error.code === 'DUPLICATE_DEFINITION', churned.status === 'rejected' ? churned.error.code : 'fulfilled')
  await churn.dispose()
})

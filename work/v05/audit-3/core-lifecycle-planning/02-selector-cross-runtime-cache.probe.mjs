// F-CL3 candidate: `internal/implementation-views.ts` keeps a MODULE-GLOBAL cache of candidate
// Entry descriptors (`candidateEntryCache`, keyed by Contract object, then by revision key) whose
// `requires.implementation` is the `revision.source` of the FIRST Runtime that expanded the
// selector in this process. A later Runtime that admits a different physical copy of the same
// revision key (same package id + version) plans the selector against the first Runtime's
// descriptor: `compiledExact()` compares the two copies structurally. With the third-round setup
// digest (D40) two honest fixtures with the same id/version but different setup bodies now fail with
// DUPLICATE_DEFINITION -> ENTRY_ACTIVATION_FAILED in whichever Runtime comes SECOND, although each
// Runtime alone works. Metadata-only differences leak as definition warnings. K01 says a Runtime is
// closed and immutable; here Runtime B's outcome depends on which Runtime ran first in the process.
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
import { check, main, note, settle } from './_harness.mjs'

const contractDefine = definePackage({ name: '@audit3/selector-contract', version: '1.0.0', syna: { id: 'audit3.selector' } })
const Capability = contractDefine.contract('cap')              // shared by every Runtime (a normal shared module)
const Panel = contractDefine.service('panel', { requires: { selector: Capability.selector }, setup: ({ selector }) => ({ selector }) })
const Entry = contractDefine.entry('main', { requires: { panel: Panel } })

// Two honest physical copies of "impl@1.0.0": same package id and version, different setup bodies
// (e.g. two fixtures of one package, or a real and a test build loaded in one process).
const implA = definePackage({ name: '@audit3/impl', version: '1.0.0', syna: { id: 'audit3.impl' } })
  .service({ provides: [Capability], setup: () => ({ flavour: 'A' }) })
const implB = definePackage({ name: '@audit3/impl', version: '1.0.0', syna: { id: 'audit3.impl' } })
  .service({ provides: [Capability], setup: () => ({ flavour: 'B' }) })
// A third copy: identical setup text to implB, different revision metadata only.
const implBmeta = definePackage({ name: '@audit3/impl', version: '1.0.0', syna: { id: 'audit3.impl' } })
  .service({ provides: [Capability], revisionMetadata: { displayName: 'B (renamed)' }, setup: () => ({ flavour: 'B' }) })

async function expandSelector(services) {
  const runtime = createRuntime({ services })
  const outcome = await settle(runtime.enter(Entry))
  if (outcome.status === 'fulfilled') {
    const selector = await (await outcome.value.deps.panel.load()).selector.load()
    const candidates = selector.candidates.map(c => `${c.familyId}@${c.version}:${c.availability.status}`)
    const lease = await selector.open(selector.candidates[0])
    const flavour = (await lease.implementation.load()).flavour
    await lease.dispose()
    await outcome.value.dispose()
    return { runtime, ok: true, candidates, flavour, warnings: runtime.inspect().definitionWarnings }
  }
  return { runtime, ok: false, error: outcome.error, warnings: runtime.inspect().definitionWarnings }
}

await main(async () => {
  // First Runtime in this process: admits implB. Works, and fills the module-global candidate cache
  // with implB's descriptor under (Capability, 'audit3.impl@1.0.0').
  const first = await expandSelector([Panel, implB])
  check('first Runtime (implB) expands the selector and opens the candidate', first.ok && first.flavour === 'B', first.ok ? first : first.error)
  await first.runtime.dispose()

  // Second Runtime: admits implA only. Alone it would work exactly like the first one.
  const second = await expandSelector([Panel, implA])
  check('second Runtime (implA, same key, different setup body) expands the selector (Runtime isolation, K01)', second.ok && second.flavour === 'A', second.ok ? second : second.error)
  if (!second.ok) note('failure chain in the second Runtime', { code: second.error.code, causeCode: second.error.details?.causeCode, cause: second.error.cause?.message, causeDetails: second.error.details?.causeDetails })
  await second.runtime.dispose()

  // Third Runtime: implBmeta (implB's setup text, different revision metadata). On its own it has no
  // metadata drift; a warning here can only come from another Runtime's descriptor.
  const third = await expandSelector([Panel, implBmeta])
  check('third Runtime (implBmeta) expands the selector', third.ok, third.ok ? third.candidates : third.error)
  check('third Runtime reports no definition warnings of its own (none of its descriptors drift)', third.ok && third.warnings.length === 0, third.warnings)
  await third.runtime.dispose()

  // Control: a Runtime whose Contract object is fresh (a different cache key) is unaffected.
  const freshDefine = definePackage({ name: '@audit3/selector-contract-fresh', version: '1.0.0', syna: { id: 'audit3.selector-fresh' } })
  const FreshCap = freshDefine.contract('cap')
  const FreshPanel = freshDefine.service('panel', { requires: { selector: FreshCap.selector }, setup: ({ selector }) => ({ selector }) })
  const FreshEntry = freshDefine.entry('main', { requires: { panel: FreshPanel } })
  const freshImplA = definePackage({ name: '@audit3/impl', version: '1.0.0', syna: { id: 'audit3.impl' } }).service({ provides: [FreshCap], setup: () => ({ flavour: 'A' }) })
  const control = createRuntime({ services: [FreshPanel, freshImplA] })
  const controlOutcome = await settle(control.enter(FreshEntry))
  check('control: with a Contract object no earlier Runtime used, implA expands fine', controlOutcome.status === 'fulfilled', controlOutcome.error)
  if (controlOutcome.status === 'fulfilled') await controlOutcome.value.dispose()
  await control.dispose()
}, 15_000)

// Order-dependent planning. The graph builder resolves an Entry's roots in the insertion order of
// `requires`; candidate backtracking is depth-first, so with two range choice sites whose candidates
// conflict through a lineage-unique dependency, the FIRST site to be reached keeps its preferred
// candidate and the second one backtracks. `entryDefinitionSignature()` sorts the keys, so two physical
// copies of one Entry that differ only in key order have the same id and signature (DUPLICATE_DEFINITION
// is not raised) and share one plan-template key. Consequences probed here:
//   1. the same Entry id yields two different topologies depending on key order (cold plans);
//   2. with the cache enabled, the second copy silently gets the first copy's plan, so cached and
//      uncached results differ for the same descriptor (R17: "cache on/off/evicting give identical results").
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, main, makeDefine, note } from './_harness.mjs'

function build() {
  const define = makeDefine('audit3.order')
  const F1 = makeDefine('audit3.order.fixed', '1.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({ v: 1 }) })
  const F2 = makeDefine('audit3.order.fixed', '2.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({ v: 2 }) })
  // Family P: the higher version needs F2, the lower needs F1.
  const P1 = makeDefine('audit3.order.p', '1.0.0').service('p', { requires: { fixed: F1 }, setup: () => ({}) })
  const P2 = makeDefine('audit3.order.p', '2.0.0').service('p', { requires: { fixed: F2 }, setup: () => ({}) })
  // Family Q: inverted, the higher version needs F1.
  const Q1 = makeDefine('audit3.order.q', '1.0.0').service('q', { requires: { fixed: F2 }, setup: () => ({}) })
  const Q2 = makeDefine('audit3.order.q', '2.0.0').service('q', { requires: { fixed: F1 }, setup: () => ({}) })
  // Two physical copies of one Entry, keys in different order (same id, same signature).
  const EntryPQ = define.entry('main', { requires: { p: P1.range('*'), q: Q1.range('*') } })
  const EntryQP = define.entry('main', { requires: { q: Q1.range('*'), p: P1.range('*') } })
  const services = [F1, F2, P1, P2, Q1, Q2]
  return { EntryPQ, EntryQP, services }
}

async function plan(runtime, entry) {
  const explanation = await runtime.explain(entry)
  if (!explanation.ok) return { error: explanation.error.code }
  return Object.fromEntries(Object.entries(explanation.choices).map(([site, revision]) => [site.replace(/^root>.*?\/require:/, ''), revision.replace(/^audit3\.order\./, '')]))
}

await main(async () => {
  const { EntryPQ, EntryQP, services } = build()
  check('both copies have the same Entry id', EntryPQ.id === EntryQP.id, [EntryPQ.id, EntryQP.id])

  // Cold plans in separate Runtimes (no cache interaction).
  const coldPQ = await plan(createRuntime({ services }), EntryPQ)
  const coldQP = await plan(createRuntime({ services }), EntryQP)
  note('cold plan, keys p,q', coldPQ)
  note('cold plan, keys q,p', coldQP)
  check('1. the same Entry (same id, same signature) plans to the same topology regardless of requires key order', JSON.stringify(coldPQ) === JSON.stringify(coldQP), { coldPQ, coldQP })

  // One Runtime, cache on: the second copy is served from the first copy's template.
  const cached = createRuntime({ services })
  const first = await plan(cached, EntryPQ)
  const second = await plan(cached, EntryQP)
  const stats = cached.inspect().planCache
  note('one Runtime, cache on: p,q then q,p', { first, second, stats })
  check('2. registering the second copy is not DUPLICATE_DEFINITION (signature ignores key order)', second.error === undefined, second)
  check('2. cached result for copy q,p equals its own cold result (R17: cache must not change the plan)', JSON.stringify(second) === JSON.stringify(coldQP), { cached: second, cold: coldQP })
  await cached.dispose()
})

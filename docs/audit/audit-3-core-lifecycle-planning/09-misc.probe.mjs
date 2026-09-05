// Smaller checks around the focus areas.
//  M1 run(): when the callback succeeds but the close reports UNSETTLED_ATTEMPT, the callback's result
//     is lost (the AggregateError replaces it). API_REFERENCE says "Business and cleanup errors are both
//     kept (AggregateError, or error.suppressed for run())" but says nothing about a successful result.
//  M2 Service analogue of probe 06: two physical copies of a Service whose `requires` differ only in
//     key order canonicalize (structural signature sorts keys); the copy registered first decides the
//     resolution order of its choice sites, so admission order (or dependency traversal order) can
//     change the plan of an otherwise identical Runtime.
//  M3 A range's family `uniqueWithin` drift is detected cold, not on a cache hit (same class as probe 07).
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep } from './_harness.mjs'

await main(async () => {
  // M1
  {
    const define = makeDefine('audit3.m1')
    const Stuck = define.service('stuck', { async setup() { await new Promise(() => undefined) } })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 20 } })
    const outcome = await settle(runtime.run(Entry, async deps => { void deps.stuck.load().catch(() => undefined); await sleep(5); return 'business result' }))
    note('M1 run() outcome when the callback succeeded but the close abandoned an attempt', outcome.status === 'rejected' ? outcome.error : outcome.value)
    check('M1 run() rejects with the close report and the successful business result is not recoverable from it', outcome.status === 'rejected' && outcome.error instanceof AggregateError && !('result' in outcome.error), outcome.status)
    await runtime.dispose().catch(() => undefined)
  }

  // M2
  {
    const build = (firstCopyOrder) => {
      const define = makeDefine('audit3.m2')
      const F1 = makeDefine('audit3.m2.fixed', '1.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({}) })
      const F2 = makeDefine('audit3.m2.fixed', '2.0.0').service('fixed', { uniqueWithin: 'lineage', setup: () => ({}) })
      const P1 = makeDefine('audit3.m2.p', '1.0.0').service('p', { requires: { fixed: F1 }, setup: () => ({}) })
      const P2 = makeDefine('audit3.m2.p', '2.0.0').service('p', { requires: { fixed: F2 }, setup: () => ({}) })
      const Q1 = makeDefine('audit3.m2.q', '1.0.0').service('q', { requires: { fixed: F2 }, setup: () => ({}) })
      const Q2 = makeDefine('audit3.m2.q', '2.0.0').service('q', { requires: { fixed: F1 }, setup: () => ({}) })
      const setup = () => ({})
      const ConsumerPQ = makeDefine('audit3.m2.consumer').service('consumer', { requires: { p: P1.range('*'), q: Q1.range('*') }, setup })
      const ConsumerQP = makeDefine('audit3.m2.consumer').service('consumer', { requires: { q: Q1.range('*'), p: P1.range('*') }, setup })
      const Entry = define.entry({ requires: { consumer: ConsumerPQ } })
      const copies = firstCopyOrder === 'pq' ? [ConsumerPQ, ConsumerQP] : [ConsumerQP, ConsumerPQ]
      return { runtime: createRuntime({ services: [F1, F2, P1, P2, Q1, Q2, ...copies] }), Entry }
    }
    const choices = async ({ runtime, Entry }) => {
      const explanation = await runtime.explain(Entry)
      const out = explanation.ok ? Object.fromEntries(Object.entries(explanation.choices).map(([site, rev]) => [site.replace(/^.*dependency:/, ''), rev.replace(/^audit3\.m2\./, '')])) : { error: explanation.error.code }
      await runtime.dispose()
      return out
    }
    const pqFirst = await choices(build('pq'))
    const qpFirst = await choices(build('qp'))
    note('M2 plan with the p,q copy admitted first', pqFirst)
    note('M2 plan with the q,p copy admitted first', qpFirst)
    check('M2 two Runtimes admitting the same set of definitions (copies differing only in requires key order) plan the same topology', JSON.stringify(pqFirst) === JSON.stringify(qpFirst), { pqFirst, qpFirst })
  }

  // M3
  {
    const define = makeDefine('audit3.m3')
    const Origin = makeDefine('audit3.m3.h', '1.0.0').service('h', { setup: () => ({}) })
    const DriftedFamilyOrigin = makeDefine('audit3.m3.h', '1.0.0').service('h', { uniqueWithin: 'lineage', setup: () => ({}) })
    const EntryA = define.entry('main', { requires: { h: Origin.range('*') } })
    const EntryB = define.entry('main', { requires: { h: DriftedFamilyOrigin.range('*') } })
    const cold = createRuntime({ services: [Origin] })
    const coldOutcome = await settle(cold.enter(EntryB))
    check('M3 cold: a range whose family drifts in uniqueWithin is DUPLICATE_DEFINITION', coldOutcome.status === 'rejected' && coldOutcome.error.code === 'DUPLICATE_DEFINITION', coldOutcome.error?.code ?? 'fulfilled')
    await cold.dispose()
    const warm = createRuntime({ services: [Origin] })
    const env = await warm.enter(EntryA); await env.dispose()
    const warmOutcome = await settle(warm.enter(EntryB))
    check('M3 warm: the same drift is still DUPLICATE_DEFINITION on a template hit', warmOutcome.status === 'rejected' && warmOutcome.error.code === 'DUPLICATE_DEFINITION', warmOutcome.error?.code ?? 'fulfilled')
    if (warmOutcome.status === 'fulfilled') await warmOutcome.value.dispose()
    await warm.dispose()
  }
}, 20_000)

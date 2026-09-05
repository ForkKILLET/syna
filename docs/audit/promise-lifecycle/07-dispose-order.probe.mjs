// Attack 7: disposal ordering: chain A->B->C (C loaded lazily after A Ready), SCC X<->Y reverse completion, throwing cleanup, dormant intermediate.
import { createRuntime, forward } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep } from './_harness.mjs'

await main(async () => {
  // Case A: chain, C late-loaded via B after A Ready.
  {
    const define = makeDefine('a7.chain')
    const events = []
    const C = define.service('c', { setup(_d, { onDispose }) { onDispose(() => events.push('C')); return { c: true } } })
    const B = define.service('b', { requires: { c: C }, setup({ c }, { onDispose }) { onDispose(() => events.push('B')); return { loadC: () => c.load() } } })
    const A = define.service('a', { requires: { b: B }, setup({ b }, { onDispose }) { onDispose(() => events.push('A')); return { loadB: () => b.load() } } })
    const Entry = define.entry({ requires: { a: A } })
    const runtime = createRuntime({ services: [A, B, C] })
    const env = await runtime.enter(Entry)
    const a = await env.deps.a.load()
    const b = await a.loadB()
    await b.loadC()
    await env.dispose()
    check('A: chain disposed dependant-first A,B,C', events.join(',') === 'A,B,C', events)
    await runtime.dispose()
  }
  // Case B: dormant intermediate: A ready, B never started, C ready (loaded via a direct root). Expected order A before C (K09: 符合最终依赖清理顺序).
  {
    const define = makeDefine('a7.dormant-mid')
    const events = []
    const C = define.service('c', { setup(_d, { onDispose }) { onDispose(() => events.push('C')); return { c: true } } })
    const B = define.service('b', { requires: { c: C }, setup(_d, { onDispose }) { onDispose(() => events.push('B')); return {} } })
    const A = define.service('a', { requires: { b: B }, setup(_d, { onDispose }) { onDispose(() => events.push('A')); return {} } })
    const Entry = define.entry({ requires: { c: C, a: A } })   // order chosen so C gets a lower slot number than A
    const runtime = createRuntime({ services: [A, B, C] })
    const env = await runtime.enter(Entry)
    await env.deps.a.load()
    await env.deps.c.load()
    note('B: slots', env.inspect().nodes.map(n => `${n.label}=${n.slotId}:${n.state}`))
    await env.dispose()
    check('B: A (transitive dependant through dormant B) disposed before C', events.indexOf('A') < events.indexOf('C'), events)
    await runtime.dispose()
  }
  // Case C: SCC X<->Y reverse completion order; both orders of completion.
  for (const first of ['x', 'y']) {
    const define = makeDefine(`a7.scc-${first}`)
    const events = []
    let X, Y
    X = define.service('x', { requires: { y: forward(() => Y) }, setup(_d, { onDispose }) { onDispose(() => events.push('x')); return {} } })
    Y = define.service('y', { requires: { x: forward(() => X) }, setup(_d, { onDispose }) { onDispose(() => events.push('y')); return {} } })
    const Entry = define.entry({ requires: { x: X, y: Y } })
    const runtime = createRuntime({ services: [X, Y] })
    const env = await runtime.enter(Entry)
    await env.deps[first].load()
    await env.deps[first === 'x' ? 'y' : 'x'].load()
    await env.dispose()
    const expected = first === 'x' ? 'y,x' : 'x,y'
    check(`C: SCC completed ${first} first -> disposed in reverse completion order ${expected}`, events.join(',') === expected, events)
    await runtime.dispose()
  }
  // Case D: throwing cleanup does not stop others; errors aggregated; cleanup never starts a dormant slot; instance released.
  {
    const define = makeDefine('a7.throwing-cleanup')
    const events = []
    let dormantStarts = 0
    const Dormant = define.service('dormant', { setup() { dormantStarts += 1; return {} } })
    const Dep = define.service('dep', { setup(_d, { onDispose }) { onDispose(() => events.push('dep')); return {} } })
    const Bad = define.service('bad', { requires: { dep: Dep, dormant: Dormant }, setup({ dormant }, { onDispose }) {
      onDispose(() => events.push('bad-2'))
      onDispose(async () => { events.push('bad-1'); const r = await settle(dormant.load()); events.push(`dormant-load:${r.error?.code}`); throw new Error('bad-1 failed') })
      return {}
    } })
    const Other = define.service('other', { setup(_d, { onDispose }) { onDispose(() => { events.push('other'); throw new Error('other failed') }); return {} } })
    const Entry = define.entry({ requires: { bad: Bad, other: Other, dep: Dep, dormant: Dormant } })
    const runtime = createRuntime({ services: [Dormant, Dep, Bad, Other] })
    const env = await runtime.enter(Entry)
    await env.deps.bad.load(); await env.deps.other.load(); await env.deps.dep.load()
    const r = await settle(env.dispose())
    check('D: dispose rejects with AggregateError', r.error instanceof AggregateError, r.error)
    const flat = e => e instanceof AggregateError ? e.errors.flatMap(flat) : [e]
    const msgs = flat(r.error).map(e => e.message)
    check('D: both cleanup errors kept', msgs.some(m => /bad-1 failed/.test(m)) && msgs.some(m => /other failed/.test(m)), msgs)
    check('D: every cleanup ran (reverse registration inside a slot), dependant before dependency', events.indexOf('bad-1') < events.indexOf('bad-2') && events.includes('other') && events.indexOf('bad-2') < events.indexOf('dep'), events)
    check('D: cleanup did not start the dormant slot', dormantStarts === 0 && events.includes('dormant-load:INVALID_ENV_STATE'), { dormantStarts, events })
    check('D: env state disposed, slots disposed', env.state === 'disposed' && env.inspect().nodes.every(n => n.state === 'disposed'), env.inspect().nodes.map(n => n.state))
    await runtime.dispose().catch(() => undefined)
  }
})

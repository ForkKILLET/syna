// Issue 4c: an abandoned setup keeps running after its dependencies were disposed.
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p4', version: '1.0.0', syna: { id: 'probe.p4' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const events = []
const Dep = define.service('dep', { async setup(_d, { onDispose }) { const h = { closed: false, use() { if (h.closed) throw new Error('used after close'); return 'ok' } }; onDispose(() => { h.closed = true; events.push('dep-closed') }); return h } })
const gate = deferred()
let lateOutcome
const Slow = define.service('slow', {
  requires: { dep: Dep },
  async setup({ dep }, { signal, onDispose }) {
    const d = await dep.load()
    events.push('slow-got-dep')
    await gate.promise            // non-cooperative: ignores signal
    events.push('slow-resumed signal.aborted=' + signal.aborted)
    try { d.use(); lateOutcome = 'used dep fine' } catch (e) { lateOutcome = e.message }
    onDispose(() => events.push('slow-late-cleanup'))
    return {}
  },
})
const Entry = define.entry({ requires: { slow: Slow, dep: Dep } })
const runtime = createRuntime({ services: [Dep, Slow], disposal: { graceMs: 20 }, diagnostics: { onEvent: e => events.push(e.type) } })
const env = await runtime.enter(Entry)
void env.deps.slow.load().catch(() => {})
await sleep(10)
const t = Date.now()
await env.dispose().catch(e => events.push('dispose rejected ' + e.errors.map(x => x.code).join(',') + ' after ' + (Date.now() - t) + 'ms'))
events.push('slot states: ' + env.inspect().nodes.filter(n => n.kind === 'service').map(n => n.label + '=' + n.state).join(' '))
gate.resolve()
await sleep(20)
console.log(events.join('\n'))
console.log('late setup outcome:', lateOutcome)
await runtime.dispose().catch(() => {})

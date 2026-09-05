// Issue 1a / 4a: after a failed rollback, can a later load() start a new setup (stacking resources)?
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p1', version: '1.0.0', syna: { id: 'probe.p1' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let setups = 0
let resourcesHeld = 0
const Svc = define.service({
  failure: { attempts: 2, delayMs: 5, afterExhaustion: 'retry-on-next-load', cooldownMs: 10 },
  async setup(_deps, { onDispose }) {
    setups += 1
    resourcesHeld += 1
    onDispose(() => { throw new Error('rollback failed: resource still held') })
    throw new Error('setup failed')
  },
})
const Entry = define.entry({ requires: { svc: Svc } })
const runtime = createRuntime({ services: [Svc] })
const env = await runtime.enter(Entry)
const first = await env.deps.svc.load().then(() => 'ok', e => e)
console.log('first load ->', first?.constructor?.name, first?.message, 'setups', setups, 'held', resourcesHeld)
console.log('slot state after first sequence:', env.inspect().nodes.find(n => n.kind === 'service').state)
await sleep(20)
const second = await env.deps.svc.load().then(() => 'ok', e => e)
console.log('second load ->', second?.constructor?.name, second?.code ?? '', second?.message, 'setups', setups, 'held', resourcesHeld)
console.log(setups === 1 ? 'PASS no new attempt after failed rollback' : 'FAIL a new attempt ran after a failed rollback (resources stacked: ' + resourcesHeld + ')')
await runtime.dispose().catch(e => console.log('dispose ->', e.message))

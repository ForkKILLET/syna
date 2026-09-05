// Issue 3: after a bounded dispose() with an abandoned attempt, how long is the Env retained, and what does it retain?
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p3', version: '1.0.0', syna: { id: 'probe.p3' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})
const Big = define.service('big', { async setup() { return { payload: Buffer.alloc(1 << 20) } } })   // 1 MiB instance per Env
const Stuck = define.service('stuck', { async setup(_d, { onDispose }) { onDispose(() => {}); await never(); return {} } })
const Root = define.entry('root', {})
const Child = define.entry('child', { requires: { big: Big, stuck: Stuck } })
const runtime = createRuntime({ services: [Big, Stuck], disposal: { graceMs: 10 } })
const root = await runtime.enter(Root)
const refs = []
// The loop runs in its own function: a suspended top-level frame keeps the last iteration's `child`
// register alive (a V8 artefact of the probe itself, seen as 1/50 retained), which is not Runtime retention.
async function createAll() {
for (let i = 0; i < 50; i += 1) {
  const child = await root.enter(Child)
  await child.deps.big.load()
  void child.deps.stuck.load().catch(() => {})
  await sleep(1)
  await child.dispose().catch(() => {})
  refs.push(new WeakRef(child))
}
}
await createAll()
globalThis.gc?.()
await sleep(50)
globalThis.gc?.()
const alive = refs.filter(r => r.deref()).length
console.log('children disposed with abandoned attempts:', refs.length, 'states:', [...new Set(refs.map(r => r.deref()?.state))])
console.log('runtime.inspect():', JSON.stringify({ rootEnvCount: runtime.inspect().rootEnvCount, liveEnvCount: runtime.inspect().liveEnvCount }))
console.log('EnvImpl objects still reachable after gc:', alive, '/', refs.length)
console.log('root children set size:', root.children?.size ?? 'n/a')
console.log('heapUsed MiB:', (process.memoryUsage().heapUsed / (1 << 20)).toFixed(1))
const t0 = Date.now()
await root.dispose().catch(e => console.log('root.dispose ->', e.constructor.name, e.errors?.length, 'errors in', Date.now() - t0, 'ms'))
console.log('root.state after dispose:', root.state, '| liveEnvCount:', runtime.inspect().liveEnvCount)
const t1 = Date.now()
await runtime.dispose().catch(e => console.log('runtime.dispose ->', e.constructor.name, 'in', Date.now() - t1, 'ms'))
console.log('after runtime.dispose: liveEnvCount', runtime.inspect().liveEnvCount, 'rootEnvCount', runtime.inspect().rootEnvCount)
console.log(alive === 0 ? 'PASS nothing retained' : 'FAIL ' + alive + ' Envs (each with its plan, slots and instances graph) retained without bound')

import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p6', version: '1.0.0', syna: { id: 'probe.p6' } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const events = []
let cleanups = 0
let gate = new Promise(() => undefined)
const Stuck = define.service('stuck', { async setup(_deps, { onDispose }) { onDispose(() => { cleanups += 1 }); await gate; return {} } })
const Root = define.entry('root', {})
const Child = define.entry('child', { requires: { stuck: Stuck } })
const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type) } })
const root = await runtime.enter(Root)
let dropped = await root.enter(Child)
void dropped.deps.stuck.load().catch(() => undefined)
await sleep(2)
await dropped.dispose().catch(() => undefined)
const droppedRef = new WeakRef(dropped)
dropped = undefined
const kept = await root.enter(Child)
void kept.deps.stuck.load().catch(() => undefined)
await sleep(2)
await kept.dispose().catch(() => undefined)
gate = undefined
for (let i = 0; i < 20; i += 1) { globalThis.gc(); await sleep(20) }
console.log(JSON.stringify({ droppedCollected: droppedRef.deref() === undefined, keptState: kept.state, cleanups, ledger: runtime.inspect().unsettledAttempts.length, events }))
await runtime.dispose().catch(() => undefined)

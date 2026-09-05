// Attack 1: un-awaited load() inside setup; dependency fails later. Also: is a rejected un-awaited load() ever reported as unhandled?
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick, trackUnhandled, waitFor } from './_harness.mjs'

await main(async () => {
  const unhandled = trackUnhandled()
  const define = makeDefine('a1.unawaited')
  const gate = deferred()
  let depStarts = 0
  const Dep = define.service('dep', { async setup() { depStarts += 1; await gate.promise; throw new Error('dep failed late') } })
  const Consumer = define.service('consumer', {
    requires: { dep: Dep },
    setup({ dep }) {
      void dep.load()            // deliberately NOT caught: plain-Promise semantics say this is the user's problem
      return { token: Symbol('consumer') }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer, dep: Dep } })
  const runtime = createRuntime({ services: [Consumer, Dep] })
  const env = await runtime.enter(Entry)
  const first = await env.deps.consumer.load()
  check('consumer is Ready while dep is still pending', typeof first.token === 'symbol', env.inspect().nodes.map(n => `${n.label}:${n.state}`))
  gate.resolve()
  await sleep(10)
  const depResult = await settle(env.deps.dep.load())
  check('dep is sticky failed afterwards', depResult.status === 'rejected' && /dep failed late/.test(depResult.error.message), depResult.error)
  const second = await env.deps.consumer.load()
  check('consumer NOT poisoned: later load() returns the same instance', second === first, second === first)
  check('dep setup ran exactly once', depStarts === 1, depStarts)
  await tick(); await sleep(10)
  // The un-awaited, un-caught load() rejected. Did Node see an unhandled rejection?
  note('unhandledRejection count for un-awaited un-caught load() joining a running attempt', unhandled.length)
  check('observation recorded: un-awaited rejected load() is silently pre-handled (0 unhandled)', unhandled.length === 0, unhandled.length)
  // Contrast: un-awaited load() on an ALREADY failed slot
  void env.deps.dep.load()
  await tick(); await sleep(10)
  note('unhandledRejection count after un-awaited load() on already-failed slot', unhandled.length)
  check('inconsistency observed: same user code, unhandled only when slot already failed', unhandled.length === 1, unhandled.length)
  await runtime.dispose()
})

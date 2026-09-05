// Attack 4: two waiters, one aborts; other continues; attempt not cancelled; aborted waiter never receives the instance.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  {
    const define = makeDefine('a4.waiters')
    const gate = deferred()
    let starts = 0
    const Shared = define.service('shared', { async setup() { starts += 1; await gate.promise; return { id: 'shared' } } })
    const Entry = define.entry({ requires: { shared: Shared } })
    const runtime = createRuntime({ services: [Shared] })
    const env = await runtime.enter(Entry)
    const controller = new AbortController()
    let abortedOutcome
    const aborted = env.deps.shared.load({ signal: controller.signal }).then(v => { abortedOutcome = { resolved: v } }, e => { abortedOutcome = { rejected: e } })
    const patient = env.deps.shared.load()
    controller.abort()
    await aborted
    check('aborted waiter rejects LOAD_CANCELLED', abortedOutcome.rejected?.code === 'LOAD_CANCELLED', abortedOutcome.rejected)
    check('slot still starting (attempt not cancelled)', env.inspect().nodes[0].state === 'starting', env.inspect().nodes[0].state)
    gate.resolve()
    const value = await patient
    check('patient waiter receives the instance', value.id === 'shared', value)
    await tick()
    check('aborted waiter never later receives the instance', abortedOutcome.rejected !== undefined && abortedOutcome.resolved === undefined, abortedOutcome)
    check('setup ran once', starts === 1, starts)
    await runtime.dispose()
  }
  // Pre-aborted signal on a dormant slot: does load() still START the attempt?
  {
    const define = makeDefine('a4.pre-aborted')
    let starts = 0
    const Svc = define.service('svc', { setup() { starts += 1; return {} } })
    const Entry = define.entry({ requires: { svc: Svc } })
    const runtime = createRuntime({ services: [Svc] })
    const env = await runtime.enter(Entry)
    const result = await settle(env.deps.svc.load({ signal: AbortSignal.abort() }))
    check('pre-aborted load() rejects LOAD_CANCELLED', result.error?.code === 'LOAD_CANCELLED', result.error)
    note('setup invocations caused by a load() whose signal was already aborted', starts)
    check('observation: pre-aborted load() still starts the dormant slot', starts === 1, starts)
    await runtime.dispose()
  }
  // Abort during retry backoff: waiter leaves, sequence continues to next attempt.
  {
    const define = makeDefine('a4.abort-in-backoff')
    let attempts = 0
    const Flaky = define.service('flaky', { failure: { attempts: 2, delayMs: 30 }, setup() { attempts += 1; if (attempts === 1) throw new Error('first'); return { attempts } } })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky] })
    const env = await runtime.enter(Entry)
    const controller = new AbortController()
    const cancelled = settle(env.deps.flaky.load({ signal: controller.signal }))
    await sleep(5)
    controller.abort()
    const c = await cancelled
    check('waiter aborted during backoff -> LOAD_CANCELLED', c.error?.code === 'LOAD_CANCELLED', c.error)
    const value = await env.deps.flaky.load()
    check('sequence continued and second attempt succeeded for a later waiter', value.attempts === 2 && attempts === 2, { value, attempts })
    await runtime.dispose()
  }
})

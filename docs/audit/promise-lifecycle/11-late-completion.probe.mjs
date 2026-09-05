// Attack 11: late completion after owner began closing: instance discarded, cleanups run, waiter gets INVALID_ENV_STATE mentioning "discarded". Variants: reject-late, retry attempt in flight, eager during child activation.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  // Case A: resolve late during closing.
  {
    const define = makeDefine('a11.resolve-late')
    const gate = deferred()
    const events = []
    let instance
    const Slow = define.service('slow', { async setup(_d, { onDispose }) { onDispose(() => events.push('cleanup')); await gate.promise; instance = { id: 'late' }; return instance } })
    const Entry = define.entry({ requires: { slow: Slow } })
    const runtime = createRuntime({ services: [Slow] })
    const env = await runtime.enter(Entry)
    const loading = settle(env.deps.slow.load())
    await tick()
    const disposing = env.dispose()
    check('A: env.state disposing immediately', env.state === 'disposing', env.state)
    gate.resolve()
    await disposing
    const r = await loading
    check('A: waiter gets INVALID_ENV_STATE mentioning discarded', r.error?.code === 'INVALID_ENV_STATE' && /discarded/.test(r.error.message), r.error)
    check('A: cleanup ran once', events.join(',') === 'cleanup', events)
    check('A: slot ends disposed (not ready)', env.inspect().nodes[0].state === 'disposed', env.inspect().nodes[0].state)
    const after = await settle(env.deps.slow.load())
    check('A: load after disposal -> INVALID_ENV_STATE', after.error?.code === 'INVALID_ENV_STATE', after.error?.code)
    await runtime.dispose()
  }
  // Case B: reject late during closing -> waiter gets the business error (not masked), cleanups run.
  {
    const define = makeDefine('a11.reject-late')
    const gate = deferred()
    const events = []
    const Slow = define.service('slow', { async setup(_d, { onDispose }) { onDispose(() => events.push('cleanup')); await gate.promise; throw new Error('business failure') } })
    const Entry = define.entry({ requires: { slow: Slow } })
    const runtime = createRuntime({ services: [Slow] })
    const env = await runtime.enter(Entry)
    const loading = settle(env.deps.slow.load())
    await tick()
    const disposing = env.dispose()
    gate.resolve()
    await disposing
    const r = await loading
    check('B: waiter gets the business error', r.error?.message === 'business failure', r.error)
    check('B: cleanup ran', events.join(',') === 'cleanup', events)
    await runtime.dispose()
  }
  // Case C: retry policy attempts:3 with the first attempt pending; owner closes; attempt resolves -> no retry, discarded.
  {
    const define = makeDefine('a11.retry-late')
    const gate = deferred()
    let attempts = 0
    const Flaky = define.service('flaky', { failure: { attempts: 3, delayMs: 5 }, async setup() { attempts += 1; await gate.promise; throw new Error('fail') } })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky] })
    const env = await runtime.enter(Entry)
    const loading = settle(env.deps.flaky.load())
    await tick()
    const disposing = env.dispose()
    gate.resolve()
    await disposing
    const r = await loading
    await sleep(20)
    check('C: no retry after owner began closing', attempts === 1, attempts)
    check('C: waiter rejected', r.status === 'rejected', r.error)
    await runtime.dispose()
  }
  // Case D: parent disposes while a child is activating (eager pending) -> child enter fails; nothing leaks.
  {
    const define = makeDefine('a11.child-activating')
    const gate = deferred()
    const events = []
    const Eager = define.service('eager', { eager: true, async setup(_d, { onDispose, signal }) { onDispose(() => events.push('cleanup')); signal.addEventListener('abort', () => gate.resolve(), { once: true }); await gate.promise; return {} } })
    const Root = define.entry('root', {})
    const Child = define.entry('child', { requires: { eager: Eager } })
    const runtime = createRuntime({ services: [Eager] })
    const root = await runtime.enter(Root)
    const entering = settle(root.enter(Child))
    await tick()
    await root.dispose()
    const r = await entering
    check('D: child enter fails ENTRY_ACTIVATION_FAILED when parent disposes mid-activation', r.error?.code === 'ENTRY_ACTIVATION_FAILED', r.error?.code)
    check('D: eager instance discarded with cleanup', events.join(',') === 'cleanup', events)
    check('D: no live envs', runtime.inspect().liveEnvCount === 0, runtime.inspect().liveEnvCount)
    await runtime.dispose()
  }
}, 10000)

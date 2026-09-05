// Attack 2: Promise.race([dep.load(), timeout]) fallback; dependency resolves/rejects late; owner disposes while pending.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  // Case A: dep resolves late while owner alive -> dep becomes Ready normally; consumer stays degraded.
  {
    const define = makeDefine('a2.race-late-resolve')
    const gate = deferred()
    const events = []
    const Dep = define.service('dep', { async setup(_d, { onDispose }) { onDispose(() => events.push('dep-cleanup')); await gate.promise; return { real: true } } })
    const Consumer = define.service('consumer', {
      requires: { dep: Dep },
      async setup({ dep }) {
        const value = await Promise.race([dep.load(), sleep(5).then(() => ({ fallback: true }))])
        return { value }
      },
    })
    const Entry = define.entry({ requires: { consumer: Consumer, dep: Dep } })
    const runtime = createRuntime({ services: [Consumer, Dep] })
    const env = await runtime.enter(Entry)
    const consumer = await env.deps.consumer.load()
    check('A: consumer Ready with fallback value', consumer.value.fallback === true, consumer.value)
    gate.resolve()
    const dep = await env.deps.dep.load()
    check('A: dep resolves late and becomes Ready', dep.real === true, dep)
    check('A: consumer unchanged after dep late resolution', (await env.deps.consumer.load()) === consumer, true)
    await env.dispose()
    check('A: dep cleanup ran on dispose', events.includes('dep-cleanup'), events)
    await runtime.dispose()
  }
  // Case B: dep rejects late -> consumer unaffected, dep sticky failed.
  {
    const define = makeDefine('a2.race-late-reject')
    const gate = deferred()
    const Dep = define.service('dep', { async setup() { await gate.promise; throw new Error('late reject') } })
    const Consumer = define.service('consumer', {
      requires: { dep: Dep },
      async setup({ dep }) {
        const value = await Promise.race([dep.load(), sleep(5).then(() => ({ fallback: true }))])
        return { value }
      },
    })
    const Entry = define.entry({ requires: { consumer: Consumer, dep: Dep } })
    const runtime = createRuntime({ services: [Consumer, Dep] })
    const env = await runtime.enter(Entry)
    const consumer = await env.deps.consumer.load()
    gate.resolve()
    const depResult = await settle(env.deps.dep.load())
    check('B: dep late rejection is a normal sticky failure', depResult.status === 'rejected' && /late reject/.test(depResult.error.message), depResult.error)
    check('B: consumer stays Ready (same instance)', (await env.deps.consumer.load()) === consumer, env.inspect().nodes.map(n => `${n.label}:${n.state}`))
    await runtime.dispose()
  }
  // Case C: owner disposes while dep still pending; dep resolves during disposal -> discarded + cleanups.
  {
    const define = makeDefine('a2.race-dispose-pending')
    const gate = deferred()
    const events = []
    const Dep = define.service('dep', { async setup(_d, { onDispose, signal }) {
      onDispose(() => events.push('dep-cleanup'))
      signal.addEventListener('abort', () => { events.push('dep-signal'); gate.resolve() }, { once: true })
      await gate.promise
      return { real: true }
    } })
    const Consumer = define.service('consumer', {
      requires: { dep: Dep },
      async setup({ dep }, { onDispose }) {
        onDispose(() => events.push('consumer-cleanup'))
        const value = await Promise.race([dep.load(), sleep(5).then(() => ({ fallback: true }))])
        return { value }
      },
    })
    const Entry = define.entry({ requires: { consumer: Consumer, dep: Dep } })
    const runtime = createRuntime({ services: [Consumer, Dep], disposal: { graceMs: 50 } })
    const env = await runtime.enter(Entry)
    await env.deps.consumer.load()
    const depLoad = settle(env.deps.dep.load())
    const started = Date.now()
    const disposal = await settle(env.dispose())
    const elapsed = Date.now() - started
    const depResult = await depLoad
    check('C: dispose() succeeds (cooperative dep settled on signal)', disposal.status === 'fulfilled', disposal.error)
    check('C: dep waiter gets INVALID_ENV_STATE mentioning discarded', depResult.status === 'rejected' && depResult.error.code === 'INVALID_ENV_STATE' && /discarded/.test(depResult.error.message), depResult.error)
    check('C: order: signal -> dep cleanup; consumer cleanup ran', events.indexOf('dep-signal') >= 0 && events.indexOf('dep-cleanup') > events.indexOf('dep-signal') && events.includes('consumer-cleanup'), events)
    note('C: dispose elapsed ms', elapsed)
    await runtime.dispose()
  }
  // Case D: owner disposes while a NON-cooperative dep (never settles, no setupDeadlineMs) is pending.
  // Doc SEMANTIC_CHANGES §4: "再等已登记 attempt（最多 disposal.graceMs）" -> expect dispose to finish within ~graceMs.
  {
    const define = makeDefine('a2.race-dispose-stuck')
    const Dep = define.service('dep', { setup: () => new Promise(() => undefined) })
    const Consumer = define.service('consumer', {
      requires: { dep: Dep },
      async setup({ dep }) {
        const value = await Promise.race([dep.load(), sleep(5).then(() => ({ fallback: true }))])
        return { value }
      },
    })
    const Entry = define.entry({ requires: { consumer: Consumer, dep: Dep } })
    const runtime = createRuntime({ services: [Consumer, Dep], initialization: { deadlineMs: 600 }, disposal: { graceMs: 20 } })
    const env = await runtime.enter(Entry)
    await env.deps.consumer.load()
    check('D: dep slot is starting before dispose', env.inspect().nodes.find(n => /dep/.test(n.label)).state === 'starting', env.inspect().nodes.map(n => `${n.label}:${n.state}`))
    const started = Date.now()
    const disposal = await settle(env.dispose())
    const elapsed = Date.now() - started
    note('D: dispose elapsed ms with deadlineMs=600, graceMs=20', elapsed)
    check('D: dispose() finishes within graceMs-ish (<200ms) per doc "最多 disposal.graceMs"', elapsed < 200, elapsed)
    check('D: dispose() reports UNSETTLED_ATTEMPT', disposal.status === 'rejected' && disposal.error.errors?.some(e => e.code === 'UNSETTLED_ATTEMPT'), disposal.error)
    await runtime.dispose().catch(() => undefined)
  }
}, 12000)

// Attack 6: eager slot failure during enter(): siblings cleaned; ENTRY_ACTIVATION_FAILED with cause; rootEnvCount 0; lazy sibling started by the failing eager setup.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  {
    const define = makeDefine('a6.eager')
    const events = []
    const okGate = deferred()
    const lazyGate = deferred()
    const Lazy = define.service('lazy', { async setup(_d, { onDispose }) { events.push('lazy-start'); onDispose(() => events.push('lazy-cleanup')); await lazyGate.promise; return { lazy: true } } })
    const AwaitedLazy = define.service('awaited-lazy', { setup(_d, { onDispose }) { events.push('awaited-lazy-start'); onDispose(() => events.push('awaited-lazy-cleanup')); return {} } })
    const GoodEager = define.service('good-eager', { eager: true, async setup(_d, { onDispose, signal }) {
      events.push('good-start'); onDispose(() => events.push('good-cleanup'))
      signal.addEventListener('abort', () => { events.push('good-signal'); okGate.resolve() }, { once: true })
      await okGate.promise; events.push('good-done'); return {}
    } })
    const FastEager = define.service('fast-eager', { eager: true, setup(_d, { onDispose }) { events.push('fast-start'); onDispose(() => events.push('fast-cleanup')); return {} } })
    const BadEager = define.service('bad-eager', { eager: true, requires: { lazy: Lazy, awaited: AwaitedLazy }, async setup({ lazy, awaited }) {
      events.push('bad-start')
      void lazy.load().catch(() => undefined)     // background: lazy sibling started but not awaited
      await awaited.load()                        // awaited sibling
      await tick()
      throw new Error('bad eager failed')
    } })
    const Entry = define.entry({ requires: { good: GoodEager, fast: FastEager, bad: BadEager, lazy: Lazy } })
    // NOTE: without a small runtime deadline this enter() blocks ~30 s: the un-awaited lazy sibling keeps disposal waiting.
    const runtime = createRuntime({ services: [Lazy, AwaitedLazy, GoodEager, FastEager, BadEager], initialization: { deadlineMs: 300 }, disposal: { graceMs: 30 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const started = Date.now()
    const result = await settle(runtime.enter(Entry))
    const elapsed = Date.now() - started
    note('enter() rejection latency (ms) with a background-started lazy sibling that never settles; deadlineMs=300 graceMs=30', elapsed)
    check('enter() rejection is not delayed by the whole initialization deadline (<150ms)', elapsed < 150, elapsed)
    check('enter() rejects with ENTRY_ACTIVATION_FAILED', result.error?.code === 'ENTRY_ACTIVATION_FAILED', result.error)
    check('cause is the eager setup error', result.error?.cause?.message === 'bad eager failed', result.error?.cause)
    check('rootEnvCount is 0, liveEnvCount 0', runtime.inspect().rootEnvCount === 0 && runtime.inspect().liveEnvCount === 0, runtime.inspect())
    check('fast eager sibling (Ready before failure) was cleaned up', events.includes('fast-cleanup'), events)
    check('slow eager sibling saw the stop signal, then was discarded with cleanup', events.indexOf('good-signal') >= 0 && events.indexOf('good-cleanup') > events.indexOf('good-done'), events)
    check('awaited lazy sibling (Ready) cleaned up', events.includes('awaited-lazy-cleanup'), events)
    // lazy sibling started in background by the failing eager: it's still pending; dispose waits for it (blocking!) unless released.
    note('lazy (background, un-awaited) started?', events.includes('lazy-start'))
    check('background lazy sibling reported as abandoned (never settled)', events.includes('attempt-abandoned'), events)
    check('ENTRY_ACTIVATION_FAILED carries suppressed disposal error with UNSETTLED_ATTEMPT', result.error?.suppressed?.errors?.some(e => e.code === 'UNSETTLED_ATTEMPT'), result.error?.suppressed)
    note('all events', events)
    lazyGate.resolve()
    await sleep(20)
    check('late settlement of the abandoned lazy sibling still runs its cleanup and reports', events.includes('lazy-cleanup') && events.includes('late-setup-result'), events)
    await runtime.dispose().catch(e => note('runtime.dispose error', e))
  }
  // Case B: runtime.dispose() while enter() is pending (eager attempt in flight).
  {
    const define = makeDefine('a6.dispose-during-enter')
    const gate = deferred()
    const events = []
    const Eager = define.service('eager', { eager: true, async setup(_d, { onDispose, signal }) {
      onDispose(() => events.push('cleanup'))
      signal.addEventListener('abort', () => { events.push('signal'); gate.resolve() }, { once: true })
      await gate.promise; return { id: 'eager' }
    } })
    const Entry = define.entry({ requires: { eager: Eager } })
    const runtime = createRuntime({ services: [Eager] })
    const entering = settle(runtime.enter(Entry))
    await sleep(5)
    check('B: root counted while activating', runtime.inspect().rootEnvCount === 1, runtime.inspect().rootEnvCount)
    await runtime.dispose()
    const r = await entering
    check('B: pending enter() rejects with ENTRY_ACTIVATION_FAILED after runtime.dispose()', r.error?.code === 'ENTRY_ACTIVATION_FAILED', r.error)
    check('B: cause mentions discarded/closing', /discarded|closing|closed/.test(r.error?.cause?.message ?? ''), r.error?.cause?.message)
    check('B: eager instance discarded with cleanup; signal seen first', events.join(',') === 'signal,cleanup', events)
    check('B: rootEnvCount 0', runtime.inspect().rootEnvCount === 0, runtime.inspect().rootEnvCount)
    const again = await settle(runtime.enter(Entry))
    check('B: enter after runtime dispose -> INVALID_ENV_STATE', again.error?.code === 'INVALID_ENV_STATE', again.error?.code)
  }
  // Case C: eager failure in a CHILD env: parent unaffected, parent-owned slots untouched.
  {
    const define = makeDefine('a6.child-eager')
    const events = []
    const Shared = define.service('shared', { setup(_d, { onDispose }) { onDispose(() => events.push('shared-cleanup')); return { shared: true } } })
    const Bad = define.service('bad', { eager: true, requires: { shared: Shared }, async setup({ shared }) { await shared.load(); throw new Error('child eager failed') } })
    const Root = define.entry('root', { requires: { shared: Shared } })
    const Child = define.entry('child', { requires: { bad: Bad, shared: Shared } })
    const runtime = createRuntime({ services: [Shared, Bad] })
    const root = await runtime.enter(Root)
    const r = await settle(root.enter(Child))
    check('C: child enter fails ENTRY_ACTIVATION_FAILED', r.error?.code === 'ENTRY_ACTIVATION_FAILED', r.error?.code)
    check('C: parent still ready; inherited shared slot (loaded by the failing child eager) is NOT disposed', root.state === 'ready' && !events.includes('shared-cleanup') && (await root.deps.shared.load()).shared === true, events)
    check('C: child count on root is 0', root.inspect() && runtime.inspect().liveEnvCount === 1, runtime.inspect().liveEnvCount)
    await runtime.dispose()
    check('C: shared cleaned on root dispose', events.includes('shared-cleanup'), events)
  }
}, 12000)

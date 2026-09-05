// Attack 8: owner stop signal reaches cleanup waiters first; child/parent concurrent disposal; sequential descendant disposal vs "broadcast cancellation first".
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  // Case A: cleanup waits for signal abort -> no deadlock.
  {
    const define = makeDefine('a8.signal-first')
    const events = []
    const Worker = define.service('worker', { setup(_d, { signal, onDispose }) {
      const stopped = new Promise(resolve => signal.addEventListener('abort', () => { events.push('signal'); resolve() }, { once: true }))
      onDispose(async () => { await stopped; events.push('cleanup') })
      return {}
    } })
    const Entry = define.entry({ requires: { worker: Worker } })
    const runtime = createRuntime({ services: [Worker] })
    const env = await runtime.enter(Entry)
    await env.deps.worker.load()
    const started = Date.now()
    await env.dispose()
    check('A: signal before cleanup, no deadlock', events.join(',') === 'signal,cleanup' && Date.now() - started < 100, events)
    await runtime.dispose()
  }
  // Case B: child disposing concurrently with parent disposing.
  {
    const define = makeDefine('a8.concurrent')
    const events = []
    const gate = deferred()
    const ChildSvc = define.service('child-svc', { setup(_d, { onDispose }) { onDispose(async () => { events.push('child-cleanup-start'); await gate.promise; events.push('child-cleanup-end') }); return {} } })
    const ParentSvc = define.service('parent-svc', { setup(_d, { onDispose }) { onDispose(() => events.push('parent-cleanup')); return {} } })
    const Root = define.entry('root', { requires: { p: ParentSvc } })
    const Child = define.entry('child', { requires: { c: ChildSvc } })
    const runtime = createRuntime({ services: [ChildSvc, ParentSvc] })
    const root = await runtime.enter(Root)
    await root.deps.p.load()
    const child = await root.enter(Child)
    await child.deps.c.load()
    const childDisposal = child.dispose()
    const rootDisposal = root.dispose()
    await tick()
    check('B: both disposing; parent cleanup waits for child', root.state === 'disposing' && child.state === 'disposing' && !events.includes('parent-cleanup'), { root: root.state, child: child.state, events })
    gate.resolve()
    await Promise.all([childDisposal, rootDisposal])
    check('B: child cleanup completed before parent cleanup; no double cleanup', events.join(',') === 'child-cleanup-start,child-cleanup-end,parent-cleanup', events)
    check('B: both disposed', root.state === 'disposed' && child.state === 'disposed', [root.state, child.state])
    await runtime.dispose()
  }
  // Case C: K09 "关闭先拒绝新工作并广播取消，再等 descendants": parent with two children; child1 has slow cleanup.
  // While parent disposal is blocked in child1, does child2 still accept new work / has child2's signal fired?
  {
    const define = makeDefine('a8.sequential-children')
    const events = []
    const gate = deferred()
    const Slow = define.service('slow', { setup(_d, { onDispose }) { onDispose(async () => { events.push('c1-cleanup-start'); await gate.promise; events.push('c1-cleanup-end') }); return {} } })
    const Lazy = define.service('lazy', { setup(_d, { onDispose }) { events.push('lazy-start'); onDispose(() => events.push('lazy-cleanup')); return { lazy: true } } })
    const Watcher = define.service('watcher', { setup(_d, { signal, onDispose }) { signal.addEventListener('abort', () => events.push('c2-signal'), { once: true }); onDispose(() => events.push('watcher-cleanup')); return {} } })
    const Root = define.entry('root', {})
    const Child1 = define.entry('child1', { requires: { slow: Slow } })
    const Child2 = define.entry('child2', { requires: { lazy: Lazy, watcher: Watcher } })
    const runtime = createRuntime({ services: [Slow, Lazy, Watcher] })
    const root = await runtime.enter(Root)
    const child1 = await root.enter(Child1); await child1.deps.slow.load()
    const child2 = await root.enter(Child2); await child2.deps.watcher.load()
    const rootDisposal = root.dispose()
    await tick(); await tick()
    note('C: states while root disposal is blocked in child1 cleanup', { root: root.state, child1: child1.state, child2: child2.state, events: [...events] })
    check('C: root refuses new work immediately', (await settle(root.derive())).error?.code === 'INVALID_ENV_STATE')
    check('C: child2 signal already aborted (cancellation broadcast before waiting)', events.includes('c2-signal'), events)
    check('C: child2 refuses new work (state not ready) while ancestor is closing', child2.state !== 'ready', child2.state)
    const lazyLoad = await settle(child2.deps.lazy.load())
    check('C: child2 dormant slot cannot be started while ancestor is closing', lazyLoad.status === 'rejected', lazyLoad.status === 'fulfilled' ? lazyLoad.value : lazyLoad.error)
    const grandchild = await settle(child2.derive())
    check('C: child2 cannot create a new descendant while ancestor is closing', grandchild.status === 'rejected', grandchild.status === 'fulfilled' ? 'created env ' + grandchild.value.id : grandchild.error?.code)
    gate.resolve()
    await rootDisposal
    check('C: everything eventually disposed', root.state === 'disposed' && child1.state === 'disposed' && child2.state === 'disposed', events)
    if (grandchild.status === 'fulfilled') note('C: grandchild created during shutdown final state', grandchild.value.state)
    await runtime.dispose()
  }
}, 10000)

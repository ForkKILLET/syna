// Attack 10: setup loading itself; synchronous throw; rejected promise; onDispose after setup finished; onDispose on a stale lifecycle from another slot's setup.
import { createRuntime, forward } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep } from './_harness.mjs'

await main(async () => {
  // Case A: self-load
  {
    const define = makeDefine('a10.self')
    let Self
    Self = define.service('self', { setupDeadlineMs: 40, requires: { me: forward(() => Self) }, async setup({ me }) { return { inner: await me.load() } } })
    const Entry = define.entry({ requires: { self: Self } })
    const runtime = createRuntime({ services: [Self], disposal: { graceMs: 20 } })
    const env = await runtime.enter(Entry)
    const r = await settle(env.deps.self.load())
    check('A: self-load hits INITIALIZATION_TIMEOUT with suspected wait cycle', r.error?.code === 'INITIALIZATION_TIMEOUT' && Array.isArray(r.error.details.suspectedWaitCycle), { code: r.error?.code, cycle: r.error?.details?.suspectedWaitCycle })
    // The raw setup promise awaits slot.sequence which already rejected -> it should settle (late-setup-failure), not stay pending.
    await sleep(30)
    const d = await settle(env.dispose())
    check('A: self-waiting setup settles once the sequence rejects (no abandoned attempt)', d.status === 'fulfilled', d.error)
    await runtime.dispose().catch(() => undefined)
  }
  // Case B: sync throw and rejected promise; cleanups registered before throw run.
  {
    const define = makeDefine('a10.throws')
    const events = []
    const SyncThrow = define.service('sync', { setup(_d, { onDispose }) { onDispose(() => events.push('sync-cleanup')); throw new TypeError('sync boom') } })
    const Rejects = define.service('rejects', { setup(_d, { onDispose }) { onDispose(() => events.push('rejects-cleanup')); return Promise.reject(new RangeError('async boom')) } })
    const Entry = define.entry({ requires: { sync: SyncThrow, rejects: Rejects } })
    const runtime = createRuntime({ services: [SyncThrow, Rejects] })
    const env = await runtime.enter(Entry)
    const a = await settle(env.deps.sync.load())
    const b = await settle(env.deps.rejects.load())
    check('B: synchronous throw surfaces as rejection with original error', a.error instanceof TypeError && a.error.message === 'sync boom', a.error)
    check('B: rejected promise surfaces original error', b.error instanceof RangeError, b.error)
    check('B: cleanups registered before failure ran', events.includes('sync-cleanup') && events.includes('rejects-cleanup'), events)
    check('B: slots sticky failed', env.inspect().nodes.every(n => n.state === 'failed'), env.inspect().nodes.map(n => n.state))
    await runtime.dispose()
  }
  // Case C: onDispose after setup finished (must throw); stale lifecycle used from another slot's setup (must throw).
  {
    const define = makeDefine('a10.stale')
    let stolen
    const late = []
    const First = define.service('first', { setup(_d, lifecycle) { stolen = lifecycle; return { addLate: () => lifecycle.onDispose(() => late.push('late')) } } })
    const Second = define.service('second', { requires: { first: First }, async setup({ first }) {
      await first.load()
      try { stolen.onDispose(() => late.push('stolen')); return { registered: true } }
      catch (error) { return { registered: false, error } }
    } })
    const Entry = define.entry({ requires: { first: First, second: Second } })
    const runtime = createRuntime({ services: [First, Second] })
    const env = await runtime.enter(Entry)
    const first = await env.deps.first.load()
    let afterError
    try { first.addLate() } catch (error) { afterError = error }
    check('C: onDispose after setup finished throws INVALID_ENV_STATE', afterError?.code === 'INVALID_ENV_STATE', afterError)
    const second = await env.deps.second.load()
    check('C: stale lifecycle of another slot rejected from another setup', second.registered === false && second.error?.code === 'INVALID_ENV_STATE', second.error)
    let typeError
    try { stolen.onDispose('not a function') } catch (error) { typeError = error }
    check('C: onDispose(non-function) -> TypeError', typeError instanceof TypeError, typeError)
    await env.dispose()
    check('C: no late/stolen cleanups ever ran', late.length === 0, late)
    await runtime.dispose()
  }
  // Case D: setup returns a thenable instance -> diagnostics event; setup returning a Promise of a Promise-like.
  {
    const define = makeDefine('a10.thenable')
    const events = []
    const Then = define.service('then', { setup() { return { then: (ok) => ok({ assimilated: true }) } } })
    const Entry = define.entry({ requires: { then: Then } })
    const runtime = createRuntime({ services: [Then], diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    const v = await env.deps.then.load()
    check('D: foreign-thenable-setup event emitted; instance is the assimilated value', events.includes('foreign-thenable-setup') && v.assimilated === true, { events, v })
    await runtime.dispose()
  }
  // Case E: setup calls load() on a sibling AFTER its own attempt timed out (late-running setup starting fresh work while owner alive).
  {
    const define = makeDefine('a10.late-load')
    const gate = deferred()
    let sideStarts = 0
    const Side = define.service('side', { setup() { sideStarts += 1; return {} } })
    const Slow = define.service('slow', { setupDeadlineMs: 20, requires: { side: Side }, async setup({ side }) { await gate.promise; await side.load(); return {} } })
    const Entry = define.entry({ requires: { slow: Slow, side: Side } })
    const runtime = createRuntime({ services: [Side, Slow] })
    const env = await runtime.enter(Entry)
    await settle(env.deps.slow.load())
    gate.resolve()
    await sleep(20)
    note('E: a timed-out (dead) attempt may still start dormant sibling slots while owner is alive', { sideStarts, side: env.inspect().nodes.find(n => /side/.test(n.label)).state })
    await runtime.dispose()
  }
}, 10000)

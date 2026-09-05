// Attack 12: unhandled rejections (run with --unhandled-rejections=strict), timers alive after runtime.dispose(), disposed child handle loading parent-owned slots, duplicate events, state strings.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick, trackUnhandled } from './_harness.mjs'

const timeouts = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length

await main(async () => {
  const unhandled = trackUnhandled()
  const baselineTimers = timeouts()
  // Case A: many internal failure paths; none may produce an unhandled rejection from inside the runtime.
  {
    const define = makeDefine('a12.internal-paths')
    const gate = deferred()
    const events = []
    const Stuck = define.service('stuck', { setupDeadlineMs: 20, failure: { attempts: 1, afterExhaustion: 'retry-on-next-load' }, async setup() { await gate.promise; throw new Error('late failure') } })
    const Bad = define.service('bad', { eager: true, setup() { throw new Error('eager bad') } })
    const AlsoEager = define.service('also', { eager: true, async setup() { await sleep(5); throw new Error('second eager failure') } })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const EagerEntry = define.entry('eager', { requires: { bad: Bad, also: AlsoEager } })
    const runtime = createRuntime({ services: [Stuck, Bad, AlsoEager], disposal: { graceMs: 20 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    await settle(env.deps.stuck.load())        // timeout
    await settle(env.deps.stuck.load())        // UNSETTLED_ATTEMPT via recovery path
    env.deps.stuck.preload()                   // preload on failed slot with unsettled attempt
    await settle(runtime.enter(EagerEntry))    // two eager failures; second rejection after Promise.all already rejected
    gate.resolve()                             // late failure -> late-setup-failure event
    await sleep(30)
    await settle(env.dispose())
    await settle(runtime.dispose())
    await tick(); await sleep(10)
    check('A: no unhandled rejections from internal paths', unhandled.length === 0, unhandled)
    check('A: late-setup-failure reported exactly once', events.filter(e => e === 'late-setup-failure').length === 1, events)
    check('A: no timers left after runtime.dispose()', timeouts() <= baselineTimers, { baselineTimers, now: timeouts() })
  }
  // Case B: abandoned attempt -> timers after dispose.
  {
    const define = makeDefine('a12.abandoned-timers')
    const Stuck = define.service('stuck', { setupDeadlineMs: 20, setup: () => new Promise(() => undefined) })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 20 } })
    const env = await runtime.enter(Entry)
    await settle(env.deps.stuck.load())
    await settle(runtime.dispose())
    await tick()
    check('B: no timers left after abandoned attempt + runtime.dispose()', timeouts() <= baselineTimers, { baselineTimers, now: timeouts() })
  }
  // Case C: a disposed child Env handle can still load (and START) a parent-owned dormant slot.
  {
    const define = makeDefine('a12.dead-handle')
    let starts = 0
    const Shared = define.service('shared', { setup() { starts += 1; return { shared: true } } })
    const Root = define.entry('root', { requires: { shared: Shared } })
    const Child = define.entry('child', { requires: { shared: Shared } })
    const runtime = createRuntime({ services: [Shared] })
    const root = await runtime.enter(Root)
    const child = await root.enter(Child)
    await child.dispose()
    check('C: child disposed', child.state === 'disposed', child.state)
    const r = await settle(child.deps.shared.load())
    note('C: load() through a DISPOSED child handle on a parent-owned dormant slot', { status: r.status, starts, value: r.value ?? r.error?.code })
    check('C: observation: disposed child handle still starts parent-owned work', r.status === 'fulfilled' && starts === 1, { status: r.status, starts })
    await runtime.dispose()
  }
  // Case D: dispose() memoisation & duplicate reporting: env.dispose() twice + runtime.dispose() -> the same error object, one attempt-abandoned event.
  {
    const define = makeDefine('a12.dup')
    const events = []
    const Stuck = define.service('stuck', { setupDeadlineMs: 20, setup: () => new Promise(() => undefined) })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 20 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    await settle(env.deps.stuck.load())
    const [d1, d2] = await Promise.all([settle(env.dispose()), settle(env.dispose())])
    const d3 = await settle(env[Symbol.asyncDispose]())
    check('D: concurrent/repeated dispose share one rejection', d1.error === d2.error && d2.error === d3.error, [d1.status, d2.status, d3.status])
    check('D: attempt-abandoned emitted once', events.filter(e => e === 'attempt-abandoned').length === 1, events)
    await settle(runtime.dispose())
  }
  // Case E: state strings during activation and after failure; runtime.inspect().rootEnvCount for an env whose dispose failed.
  {
    const define = makeDefine('a12.states')
    const gate = deferred()
    let seen
    const Eager = define.service('eager', { eager: true, async setup() { await gate.promise; return {} } })
    const Probe = define.service('probe', { eager: true, requires: { eager: Eager }, async setup({ eager }) { const p = eager.load(); seen = 'unknown'; await p; return {} } })
    const Entry = define.entry({ requires: { eager: Eager, probe: Probe } })
    const runtime = createRuntime({ services: [Eager, Probe] })
    const entering = runtime.enter(Entry)
    await tick()
    check('E: rootEnvCount counts an activating root', runtime.inspect().rootEnvCount === 1, runtime.inspect().rootEnvCount)
    gate.resolve()
    const env = await entering
    check('E: env ready; all eager slots ready', env.state === 'ready' && env.inspect().nodes.every(n => n.state === 'ready'), env.inspect().nodes.map(n => n.state))
    await runtime.dispose()
    check('E: after runtime.dispose(): env disposed, rootEnvCount 0, liveEnvCount 0', env.state === 'disposed' && runtime.inspect().rootEnvCount === 0 && runtime.inspect().liveEnvCount === 0, runtime.inspect())
  }
  await tick(); await sleep(10)
  check('overall: zero unhandled rejections in this probe', unhandled.length === 0, unhandled.map(String))
}, 10000)

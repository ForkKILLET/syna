// Attack 3: setup never settles with small setupDeadlineMs; UNSETTLED_ATTEMPT; late settlement event; recovery; dispose reporting; env.state honesty.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, waitFor } from './_harness.mjs'

await main(async () => {
  // Case A: sticky (default) policy
  {
    const define = makeDefine('a3.sticky-timeout')
    const gate = deferred()
    const events = []
    let starts = 0
    const Stuck = define.service('stuck', { setupDeadlineMs: 30, async setup(_d, { onDispose }) { starts += 1; onDispose(() => events.push('late-cleanup')); await gate.promise; return { late: true } } })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 30 }, diagnostics: { onEvent: e => events.push(e) } })
    const env = await runtime.enter(Entry)
    const first = await settle(env.deps.stuck.load())
    check('A: first waiter gets INITIALIZATION_TIMEOUT', first.status === 'rejected' && first.error.code === 'INITIALIZATION_TIMEOUT', first.error)
    check('A: timeout details carry attempt/deadline/pendingLoads/note', first.error?.details && 'pendingLoads' in first.error.details && 'deadlineMs' in first.error.details, first.error?.details)
    const second = await settle(env.deps.stuck.load())
    note('A: second load() under sticky policy', second.error)
    check('A: second load() rejects (sticky -> same INITIALIZATION_TIMEOUT, not UNSETTLED_ATTEMPT)', second.status === 'rejected' && second.error.code === 'INITIALIZATION_TIMEOUT', second.error?.code)
    check('A: no overlapping attempt started', starts === 1, starts)
    check('A: slot state string is failed', env.inspect().nodes[0].state === 'failed', env.inspect().nodes[0].state)
    gate.resolve()
    await waitFor(() => events.some(e => e?.type === 'late-setup-result'))
    check('A: late-setup-result event emitted once, late cleanup ran first', events.filter(e => e?.type === 'late-setup-result').length === 1 && events.indexOf('late-cleanup') < events.findIndex(e => e?.type === 'late-setup-result'), events.map(e => e?.type ?? e))
    const third = await settle(env.deps.stuck.load())
    check('A: after late result, sticky slot still failed (no recovery)', third.status === 'rejected' && third.error.code === 'INITIALIZATION_TIMEOUT', third.error?.code)
    await runtime.dispose()
  }
  // Case B: retry-on-next-load; UNSETTLED_ATTEMPT while raw still running; recovery only after late settlement.
  {
    const define = makeDefine('a3.recover')
    const gate = deferred()
    const events = []
    let starts = 0
    const Stuck = define.service('stuck', {
      setupDeadlineMs: 30,
      failure: { attempts: 1, afterExhaustion: 'retry-on-next-load' },
      async setup() { starts += 1; if (starts === 1) { await gate.promise; return { late: true } } return { starts } },
    })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    const first = await settle(env.deps.stuck.load())
    check('B: INITIALIZATION_TIMEOUT', first.error?.code === 'INITIALIZATION_TIMEOUT', first.error?.code)
    const second = await settle(env.deps.stuck.load())
    check('B: second load() -> UNSETTLED_ATTEMPT while raw promise still pending', second.error?.code === 'UNSETTLED_ATTEMPT', second.error)
    check('B: still exactly one setup invocation', starts === 1, starts)
    gate.resolve()
    await waitFor(() => events.includes('late-setup-result'))
    const [r1, r2] = await Promise.all([env.deps.stuck.load(), env.deps.stuck.load()])
    check('B: recovery after late settlement starts exactly one new attempt, waiters share it', r1 === r2 && r1.starts === 2 && starts === 2, { r1, starts })
    await runtime.dispose()
  }
  // Case C: never settles; dispose with small graceMs -> UNSETTLED_ATTEMPT; env.state / slot state honesty.
  {
    const define = makeDefine('a3.abandon')
    const events = []
    const Stuck = define.service('stuck', { setupDeadlineMs: 20, setup: () => new Promise(() => undefined) })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 20 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    await settle(env.deps.stuck.load())
    const disposal = await settle(env.dispose())
    check('C: dispose() rejects with UNSETTLED_ATTEMPT inside AggregateError', disposal.status === 'rejected' && disposal.error.errors?.some(e => e.code === 'UNSETTLED_ATTEMPT'), disposal.error)
    check('C: attempt-abandoned event emitted exactly once', events.filter(e => e === 'attempt-abandoned').length === 1, events)
    check('C: slot state says abandoned', env.inspect().nodes[0].state === 'abandoned', env.inspect().nodes[0].state)
    note('C: env.state after a dispose that admitted an abandoned attempt', env.state)
    check('C: env.state is not the plain string "disposed" while an owned attempt is abandoned (K08: 不能提前叫完全 Disposed)', env.state !== 'disposed', env.state)
    note('C: runtime.inspect() rootEnvCount/liveEnvCount', runtime.inspect().rootEnvCount + '/' + runtime.inspect().liveEnvCount)
    const again = await settle(env.dispose())
    check('C: second dispose() returns the same (memoised) rejection', again.status === 'rejected' && again.error === disposal.error, again.status)
    const rt = await settle(runtime.dispose())
    note('C: runtime.dispose() after the root already reported UNSETTLED_ATTEMPT (root was removed from roots)', rt.status)
  }
  // Case D: onDispose() called AFTER the deadline fired (common pattern: conn = await connect(); onDispose(close)).
  // K08: "迟到结果不能覆盖新的状态/已关闭 Env；处理 cleanup 并报告" -> the late resource should be cleaned, not leak.
  {
    const define = makeDefine('a3.late-ondispose')
    const gate = deferred()
    const events = []
    let closed = false
    const Conn = define.service('conn', {
      setupDeadlineMs: 20,
      async setup(_d, { onDispose }) {
        await gate.promise                    // slow connect
        const conn = { close: () => { closed = true } }
        try { onDispose(() => conn.close()) }   // register cleanup for the resource just created
        catch (error) { events.push(error); throw error }
        return conn
      },
    })
    const Entry = define.entry({ requires: { conn: Conn } })
    const runtime = createRuntime({ services: [Conn], diagnostics: { onEvent: e => events.push(e) } })
    const env = await runtime.enter(Entry)
    const first = await settle(env.deps.conn.load())
    check('D: waiter got INITIALIZATION_TIMEOUT', first.error?.code === 'INITIALIZATION_TIMEOUT', first.error?.code)
    gate.resolve()
    await waitFor(() => events.some(e => e?.type === 'late-setup-result' || e?.type === 'late-setup-failure'))
    const lateEvent = events.find(e => e?.type?.startsWith('late-setup'))
    note('D: onDispose() outcome inside late-running setup', events.find(e => e instanceof Error))
    note('D: late event', { type: lateEvent.type, error: lateEvent.error?.code, cleanupErrors: lateEvent.cleanupErrors?.length })
    check('D: onDispose() inside the still-running (timed-out) attempt is accepted', !events.some(e => e instanceof Error), events.find(e => e instanceof Error))
    check('D: the late-created connection was closed (no leak)', closed === true, closed)
    await runtime.dispose()
  }
}, 12000)

// Regressions for the second review round (work/v05/ISSUES.md I-50 … I-53):
// R-1 a failed rollback is final for its slot; R-1/R-4 caught cancellations
// never leave an unhandled rejection; R-3 the bounded close ends the Runtime's
// hold on an Env (retention is bounded by the user's own pending Promise);
// R-4 the dependencies of an abandoned attempt are closed in order and the
// report says so. Each case keeps a legal control next to the counterexample.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRuntime, definePackage } from '../dist/index.js'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const makeDefine = (id, version = '1.0.0') => definePackage({
  name: `@v05/${id.replaceAll('.', '-')}`,
  version,
  syna: { id },
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(2)
  }
}
const child = (flags, script, ...args) =>
  run(process.execPath, [...flags, '--input-type=module', '-e', script, ...args])
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

test('R-1 a failed rollback is final: retry-on-next-load starts no further attempt (ROLLBACK_FAILED), while a clean rollback still recovers', async () => {
  const define = makeDefine('v05.review.rollback-final')
  let setups = 0
  let held = 0
  const Leaky = define.service('leaky', {
    failure: { attempts: 2, delayMs: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    setup(_deps, { onDispose }) {
      setups += 1
      held += 1
      onDispose(() => { throw new Error(`rollback ${setups} failed`) })
      throw new Error(`attempt ${setups} failed`)
    },
  })
  let cleanSetups = 0
  const Clean = define.service('clean', {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    setup(_deps, { onDispose }) {
      cleanSetups += 1
      onDispose(() => undefined)
      if (cleanSetups === 1) throw new Error('first attempt failed')
      return { attempt: cleanSetups }
    },
  })
  const Entry = define.entry({ requires: { leaky: Leaky, clean: Clean } })
  const runtime = createRuntime({ services: [Leaky, Clean] })
  const env = await runtime.enter(Entry)

  const first = await env.deps.leaky.load().catch(error => error)
  assert.ok(first instanceof AggregateError, 'the sequence ends with the business error and the rollback error')
  assert.equal(setups, 1, 'a failed rollback ends the sequence (no in-sequence retry)')
  await sleep(5)
  const second = await env.deps.leaky.load().catch(error => error)
  assert.equal(second.code, 'ROLLBACK_FAILED')
  assert.strictEqual(second.cause, first, 'the original failure stays reachable')
  assert.equal(second.details.slot, env.inspect().nodes.find(node => node.label.includes('leaky')).slotId)
  assert.equal(setups, 1, 'no recovery attempt: resources would stack on the leaked ones')
  assert.equal(held, 1)
  const third = await env.deps.leaky.load().catch(error => error)
  assert.equal(third.code, 'ROLLBACK_FAILED', 'permanent for the slot')
  assert.equal(env.inspect().nodes.find(node => node.label.includes('leaky')).state, 'failed')

  // Control: the same policy with a rollback that succeeds recovers on the next load.
  await assert.rejects(env.deps.clean.load(), /first attempt failed/)
  await sleep(5)
  assert.deepEqual(await env.deps.clean.load(), { attempt: 2 })
  await runtime.dispose()
})

test('R-1 a late cleanup that fails after INITIALIZATION_TIMEOUT makes the slot final too; a clean late cleanup still allows recovery', async () => {
  const define = makeDefine('v05.review.late-rollback')
  const events = []
  const gates = { leaky: deferred(), clean: deferred() }
  const counts = { leaky: 0, clean: 0 }
  const service = (name, cleanupThrows) => define.service(name, {
    failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 },
    setupDeadlineMs: 20,
    async setup(_deps, { onDispose }) {
      counts[name] += 1
      if (counts[name] === 1) {
        onDispose(() => { if (cleanupThrows) throw new Error('late cleanup failed') })
        await gates[name].promise
      }
      return { attempt: counts[name] }
    },
  })
  const Leaky = service('leaky', true)
  const Clean = service('clean', false)
  const Entry = define.entry({ requires: { leaky: Leaky, clean: Clean } })
  const runtime = createRuntime({ services: [Leaky, Clean], diagnostics: { onEvent: event => events.push(event) } })
  const env = await runtime.enter(Entry)

  await assert.rejects(env.deps.leaky.load(), error => error.code === 'INITIALIZATION_TIMEOUT')
  await assert.rejects(env.deps.clean.load(), error => error.code === 'INITIALIZATION_TIMEOUT')
  assert.equal(runtime.inspect().unsettledAttempts.length, 2, 'timed-out attempts are in the ledger while their owner lives')
  assert.deepEqual(runtime.inspect().unsettledAttempts.map(item => item.state), ['timed-out', 'timed-out'])
  gates.leaky.resolve()
  gates.clean.resolve()
  await waitFor(() => events.filter(event => event.type === 'late-setup-result').length === 2)
  const leakyLate = events.find(event => event.type === 'late-setup-result' && event.revision.includes('leaky'))
  assert.equal(leakyLate.cleanupErrors.length, 1, 'the failed late cleanup is reported')
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)

  const refused = await env.deps.leaky.load().catch(error => error)
  assert.equal(refused.code, 'ROLLBACK_FAILED')
  assert.equal(counts.leaky, 1, 'no recovery on top of the resource the late cleanup could not release')
  assert.deepEqual(await env.deps.clean.load(), { attempt: 2 }, 'control: a clean late cleanup keeps recovery available')
  await runtime.dispose()
})

test('R-1/R-4 a caught cancellation never leaves an unhandled rejection, on every cancellation path', async () => {
  const script = `
    import { createRuntime, definePackage, loadAll } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v05/review-cancel', version: '1.0.0', syna: { id: 'v05.review.cancel' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
    const codes = []
    const caught = promise => promise.then(() => codes.push('ok'), error => codes.push(error.code ?? error.message))

    // A: the caller aborts while the attempt runs; the attempt fails afterwards.
    {
      const gate = deferred()
      const Svc = define.service('a', { async setup() { await gate.promise; throw new Error('late failure') } })
      const Entry = define.entry('a', { requires: { svc: Svc } })
      const runtime = createRuntime({ services: [Svc] })
      const env = await runtime.enter(Entry)
      const controller = new AbortController()
      const waiting = caught(env.deps.svc.load({ signal: controller.signal }))
      controller.abort()
      await waiting
      gate.resolve()
      await sleep(10)
      await runtime.dispose()
    }
    // B: abort inside the retry backoff, then the owner closes inside the backoff.
    {
      const Svc = define.service('b', { failure: { attempts: 3, delayMs: 200 }, async setup() { throw new Error('boom') } })
      const Entry = define.entry('b', { requires: { svc: Svc } })
      const runtime = createRuntime({ services: [Svc] })
      const env = await runtime.enter(Entry)
      const controller = new AbortController()
      const waiting = caught(env.deps.svc.load({ signal: controller.signal }))
      await sleep(10)
      controller.abort()
      await waiting
      await env.dispose()
      await runtime.dispose()
    }
    // C: abort inside a recovery cooldown shared with another waiter, then the owner closes.
    {
      const Svc = define.service('c', { failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 200 }, async setup() { throw new Error('boom') } })
      const Entry = define.entry('c', { requires: { svc: Svc } })
      const runtime = createRuntime({ services: [Svc] })
      const env = await runtime.enter(Entry)
      await caught(env.deps.svc.load())
      const controller = new AbortController()
      const mine = caught(env.deps.svc.load({ signal: controller.signal }))
      const other = caught(env.deps.svc.load())
      await sleep(10)
      controller.abort()
      await mine
      await env.dispose()
      await other
      await runtime.dispose()
    }
    // D: a setup forwards the owner signal to a dependency load, catches LOAD_CANCELLED and returns
    //    degraded while the owner is already closing; its instance is discarded (ENV_CLOSED).
    {
      const gate = deferred()
      const Dep = define.service('d-dep', { async setup() { await gate.promise; return {} } })
      const Consumer = define.service('d-consumer', {
        requires: { dep: Dep },
        async setup({ dep }, { signal }) {
          try { await dep.load({ signal }) } catch (error) { codes.push('setup:' + error.code) }
          return { degraded: true }
        },
      })
      const Entry = define.entry('d', { requires: { consumer: Consumer } })
      const runtime = createRuntime({ services: [Dep, Consumer], limits: { disposalGraceMs: 30 } })
      const env = await runtime.enter(Entry)
      const waiting = caught(env.deps.consumer.load())
      await sleep(10)
      await env.dispose().catch(() => undefined)
      await waiting
      gate.resolve()
      await sleep(10)
      await runtime.dispose().catch(() => undefined)
    }
    // E: loadAll with a signal; abort; both attempts fail later.
    {
      const gate = deferred()
      const A = define.service('e-a', { async setup() { await gate.promise; throw new Error('a failed') } })
      const B = define.service('e-b', { async setup() { await gate.promise; throw new Error('b failed') } })
      const Entry = define.entry('e', { requires: { a: A, b: B } })
      const runtime = createRuntime({ services: [A, B] })
      const env = await runtime.enter(Entry)
      const controller = new AbortController()
      const waiting = caught(loadAll({ a: env.deps.a, b: env.deps.b }, { signal: controller.signal }))
      await sleep(5)
      controller.abort()
      await waiting
      gate.resolve()
      await sleep(10)
      await runtime.dispose()
    }
    // F: the caller aborts, then the owner closes and abandons the attempt, which settles late.
    {
      const gate = deferred()
      const Svc = define.service('f', { async setup() { await gate.promise; return {} } })
      const Entry = define.entry('f', { requires: { svc: Svc } })
      const runtime = createRuntime({ services: [Svc], limits: { disposalGraceMs: 20 } })
      const env = await runtime.enter(Entry)
      const controller = new AbortController()
      const waiting = caught(env.deps.svc.load({ signal: controller.signal }))
      await sleep(5)
      controller.abort()
      await waiting
      await env.dispose().catch(() => undefined)
      gate.resolve()
      await sleep(10)
      await runtime.dispose().catch(() => undefined)
    }
    // G: a setup aborts its caller's signal synchronously (the setup runs inside the first load()).
    {
      const controller = new AbortController()
      const Svc = define.service('g', { async setup() { controller.abort(); await sleep(5); throw new Error('boom') } })
      const Entry = define.entry('g', { requires: { svc: Svc } })
      const runtime = createRuntime({ services: [Svc] })
      const env = await runtime.enter(Entry)
      await caught(env.deps.svc.load({ signal: controller.signal }))
      await sleep(10)
      await runtime.dispose()
    }
    // H: pre-aborted signals on dormant, failed and Ready slots; a background load afterwards.
    {
      const Svc = define.service('h', { async setup() { throw new Error('boom') } })
      const Ok = define.service('h-ok', { async setup() { return {} } })
      const Entry = define.entry('h', { requires: { svc: Svc, ok: Ok } })
      const runtime = createRuntime({ services: [Svc, Ok] })
      const env = await runtime.enter(Entry)
      const aborted = AbortSignal.abort()
      await caught(env.deps.svc.load({ signal: aborted }))
      await caught(env.deps.svc.load())
      await caught(env.deps.svc.load({ signal: aborted }))
      await caught(env.deps.ok.load({ signal: aborted }))
      void env.deps.svc.load().catch(() => undefined)
      await sleep(10)
      await runtime.dispose()
    }
    console.log(JSON.stringify(codes))
  `
  const result = await child(['--unhandled-rejections=strict'], script)
  assert.equal(result.code, 0, `unhandled rejection under strict mode:\n${result.stderr}`)
  const codes = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.deepEqual(codes, [
    'LOAD_CANCELLED',                       // A
    'LOAD_CANCELLED',                       // B
    'boom', 'LOAD_CANCELLED', 'ENV_CLOSED', // C: first sequence, aborted waiter, other waiter cancelled by the close
    'setup:LOAD_CANCELLED', 'ENV_CLOSED',   // D: caught inside setup; the degraded instance is discarded
    'LOAD_CANCELLED',                       // E
    'LOAD_CANCELLED',                       // F
    'LOAD_CANCELLED',                       // G
    'LOAD_CANCELLED', 'boom', 'LOAD_CANCELLED', 'LOAD_CANCELLED', // H
  ])
})

test('R-3 the bounded close ends the Runtime\'s hold on an Env: abandoned attempts live in a ledger, not in retained Env graphs', async () => {
  const define = makeDefine('v05.review.bounded-close')
  const events = []
  const gates = []
  const Stuck = define.service('stuck', {
    async setup(_deps, { onDispose }) {
      const gate = deferred()
      gates.push(gate)
      onDispose(() => events.push('cleanup'))
      await gate.promise
      return {}
    },
  })
  const Big = define.service('big', { async setup() { return { payload: new Uint8Array(1 << 16) } } })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { stuck: Stuck, big: Big } })
  const runtime = createRuntime({ services: [Stuck, Big], limits: { disposalGraceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type) } })
  const root = await runtime.enter(Root)
  const children = []
  for (let index = 0; index < 20; index += 1) {
    const env = await root.enter(Child)
    await env.deps.big.load()
    void env.deps.stuck.load().catch(() => undefined)
    children.push(env)
  }
  const started = Date.now()
  await Promise.all(children.map(env => env.dispose().catch(() => undefined)))
  assert.ok(Date.now() - started < 500, 'closing 20 Envs with stuck setups is bounded by the grace period')
  assert.equal(events.filter(event => event === 'attempt-abandoned').length, 20)
  assert.ok(children.every(env => env.state === 'disposing'), 'not claimed disposed while an attempt is outstanding (K08)')
  assert.equal(runtime.inspect().liveEnvCount, 1, 'only the root is still held by the Runtime')
  assert.equal(runtime.inspect().rootEnvCount, 1)
  const ledger = runtime.inspect().unsettledAttempts
  assert.equal(ledger.length, 20)
  assert.ok(ledger.every(item => item.state === 'abandoned' && item.revision.includes('stuck') && item.runningForMs >= 0))
  assert.deepEqual([...new Set(ledger.map(item => item.env))].sort(), children.map(env => env.id).sort())

  // A new child of the same root is unaffected by the outstanding attempts.
  const fresh = await root.enter(Child)
  assert.equal(fresh.state, 'ready')
  await fresh.deps.big.load()
  const loading = fresh.deps.stuck.load() // setup runs synchronously up to its gate: the newest gate is this one
  gates.at(-1).resolve()
  await loading
  await fresh.dispose()

  // The root closes promptly too and re-reports what is outstanding beneath it.
  const rootStarted = Date.now()
  await root.dispose().catch(() => undefined)
  assert.ok(Date.now() - rootStarted < 200)
  // The children left the tree at the end of their own bounded close, so the root's close is complete:
  // nothing the root owns is outstanding. The children themselves still say 'disposing', and the ledger lists them.
  assert.equal(root.state, 'disposed', 'the root\'s own close is complete; detached children do not hold it')
  assert.ok(children.every(env => env.state === 'disposing'))
  assert.deepEqual([runtime.inspect().rootEnvCount, runtime.inspect().liveEnvCount], [0, 0])
  await assert.rejects(runtime.dispose(), error => {
    const report = error.errors.find(item => item.code === 'UNSETTLED_ATTEMPT' && Array.isArray(item.details.attempts))
    return report !== undefined && report.details.attempts.length === 20
  }, 'runtime.dispose() re-reports the ledger instead of fulfilling silently')

  for (const gate of gates) gate.resolve()
  await waitFor(() => runtime.inspect().unsettledAttempts.length === 0)
  await waitFor(() => children.every(env => env.state === 'disposed') && root.state === 'disposed')
  assert.equal(events.filter(event => event === 'late-setup-result').length, 20)
  assert.equal(events.filter(event => event === 'cleanup').length, 21)
})

test('R-3 retention is bounded by the user\'s own Promise: a setup that can never settle is collected and its attempt closed as unreachable', async () => {
  const script = `
    import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
    const define = definePackage({ name: '@v05/review-unreachable', version: '1.0.0', syna: { id: 'v05.review.unreachable' } })
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const events = []
    let cleanups = 0
    let gate = new Promise(() => undefined) // nobody can ever resolve this
    const Stuck = define.service('stuck', { async setup(_deps, { onDispose }) { onDispose(() => { cleanups += 1 }); await gate; return {} } })
    const Root = define.entry('root', {})
    const Child = define.entry('child', { requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], limits: { disposalGraceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type + ':' + event.env) } })
    const root = await runtime.enter(Root)
    // Env 1: the handle is dropped; its whole graph must become collectable.
    let dropped = await root.enter(Child)
    const droppedId = dropped.id
    void dropped.deps.stuck.load().catch(() => undefined)
    await sleep(2)
    await dropped.dispose().catch(() => undefined)
    const droppedRef = new WeakRef(dropped)
    dropped = undefined
    // Env 2: the handle is kept; the attempt must still be closed once its Promise is dead.
    const kept = await root.enter(Child)
    void kept.deps.stuck.load().catch(() => undefined)
    await sleep(2)
    await kept.dispose().catch(() => undefined)
    const before = { ledger: runtime.inspect().unsettledAttempts.length, keptState: kept.state }
    gate = undefined // the setups' continuations are now unreachable
    // Note: WeakRef.deref() keeps its target alive until the end of the current job,
    // so the loop only watches the kept Env and derefs the dropped one once, afterwards.
    const deadline = Date.now() + 5_000
    let rounds = 0
    while (Date.now() < deadline && (kept.state !== 'disposed' || rounds < 5)) {
      globalThis.gc()
      rounds += 1
      await sleep(20)
    }
    console.log(JSON.stringify({
      before,
      droppedCollected: droppedRef.deref() === undefined,
      keptState: kept.state,
      keptSlot: kept.inspect().nodes.find(node => node.kind === 'service').state,
      cleanups,
      ledger: runtime.inspect().unsettledAttempts.length,
      unreachableEvents: events.filter(event => event.startsWith('attempt-unreachable:')).length,
      droppedEnvClosed: events.includes('attempt-unreachable:' + droppedId),
    }))
    await runtime.dispose().catch(() => undefined)
  `
  const result = await child(['--expose-gc', '--unhandled-rejections=strict'], script)
  assert.equal(result.code, 0, result.stderr)
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.deepEqual(outcome.before, { ledger: 2, keptState: 'disposing' })
  assert.equal(outcome.droppedCollected, true, 'nothing in the Runtime keeps a closed Env alive')
  assert.equal(outcome.keptState, 'disposed', 'a dead attempt is closed, so the Env no longer stays disposing forever')
  assert.equal(outcome.keptSlot, 'disposed')
  // Both attempts, the dropped Env's included: the ledger holds the attempt itself, so
  // the unreachable path can still run its cleanups after the Env graph is gone (audit 3, F-CL3-03).
  assert.equal(outcome.cleanups, 2, 'cleanups of both dead attempts were run')
  assert.equal(outcome.unreachableEvents, 2)
  assert.equal(outcome.droppedEnvClosed, true, 'the dropped Env\'s attempt was closed as unreachable, not silently forgotten')
  assert.equal(outcome.ledger, 0)
  assert.ok(outcome.unreachableEvents >= 1)
})

test('R-4 the dependencies of an abandoned attempt are closed in the normal order after the grace, and the report acknowledges it', async () => {
  const define = makeDefine('v05.review.abandoned-deps')
  const events = []
  const gate = deferred()
  let lateUse
  const Dep = define.service('dep', {
    async setup(_deps, { onDispose }) {
      const handle = { closed: false, use() { if (handle.closed) throw new Error('used after close'); return 'ok' } }
      onDispose(() => { handle.closed = true; events.push('dep-closed') })
      return handle
    },
  })
  const Slow = define.service('slow', {
    requires: { dep: Dep },
    async setup({ dep }, { signal, onDispose }) {
      const handle = await dep.load()
      await gate.promise // ignores the stop signal on purpose
      events.push(`slow-resumed:aborted=${signal.aborted}`)
      try { lateUse = handle.use() } catch (error) { lateUse = error.message }
      onDispose(() => events.push('slow-late-cleanup'))
      return {}
    },
  })
  const Entry = define.entry({ requires: { slow: Slow, dep: Dep } })
  const runtime = createRuntime({ services: [Dep, Slow], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  void env.deps.slow.load().catch(() => undefined)
  await sleep(5)
  const error = await env.dispose().catch(error => error)
  const report = error.errors.find(item => item.code === 'UNSETTLED_ATTEMPT')
  assert.deepEqual(report.details.slots[0].dependencies.map(item => [item.dependency, item.revision.includes('/dep@'), item.state]), [['dep', true, 'disposed']])
  assert.deepEqual(events, ['attempt-abandoned', 'dep-closed'], 'the dependency is closed after the grace; the abandoned attempt is not waited for')
  assert.equal(env.inspect().nodes.find(node => node.label.includes('slow')).state, 'abandoned')

  gate.resolve()
  await waitFor(() => events.includes('late-setup-result'))
  assert.equal(lateUse, 'used after close', 'the non-cooperative setup observes the closed dependency: the Runtime cannot revoke an instance it handed out')
  assert.deepEqual(events.slice(2), ['slow-resumed:aborted=true', 'slow-late-cleanup', 'late-setup-result'])
  assert.equal(env.state, 'disposed')
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  await runtime.dispose()
})

test('R-5 a setup deadline that fires inside the disposal grace does not hide the attempt: the close reports it, the Env stays disposing until it settles', async () => {
  // Third review round (C4): dispose() issued before the deadline. The setup
  // sequence settles inside the grace (by timing out), but the raw setup is still
  // running; it must get the rest of the grace and then be reported like any
  // other abandoned attempt.
  const define = makeDefine('v05.review.deadline-in-grace')
  const gate = deferred()
  const started = deferred()
  const events = []
  const Slow = define.service('slow', {
    setupDeadlineMs: 10,
    async setup(_deps, { onDispose }) {
      onDispose(() => events.push('cleanup'))
      started.resolve()
      await gate.promise
      return {}
    },
  })
  const Entry = define.entry({ requires: { slow: Slow } })
  const runtime = createRuntime({ services: [Slow], limits: { disposalGraceMs: 400 }, diagnostics: { onEvent: event => events.push(event.type) } })
  const env = await runtime.enter(Entry)
  const load = env.deps.slow.load()
  void load.catch(() => undefined)
  await started.promise
  const closedAt = Date.now()
  const error = await env.dispose().catch(error => error)
  await assert.rejects(load, error => error.code === 'INITIALIZATION_TIMEOUT')
  assert.ok(Date.now() - closedAt >= 300, 'the attempt got the remainder of the grace after its deadline')
  assert.ok(error instanceof AggregateError && error.errors.some(item => item.code === 'UNSETTLED_ATTEMPT'), `the close reports the attempt that outlived it: ${String(error)}`)
  assert.equal(env.state, 'disposing')
  assert.equal(env.inspect().nodes[0].state, 'abandoned')
  assert.ok(events.includes('attempt-abandoned'))
  assert.deepEqual([runtime.inspect().liveEnvCount, runtime.inspect().unsettledAttempts.length], [0, 1])
  assert.equal(runtime.inspect().unsettledAttempts[0].state, 'abandoned')

  gate.resolve()
  await waitFor(() => env.state === 'disposed')
  assert.ok(events.includes('cleanup'))
  assert.equal(env.inspect().nodes[0].state, 'disposed')
  assert.equal(runtime.inspect().unsettledAttempts.length, 0)
  await runtime.dispose()

  // Control: a deadline longer than the grace takes the running-attempt path and
  // yields the same report shape.
  const control = makeDefine('v05.review.deadline-after-grace')
  const controlGate = deferred()
  const controlEvents = []
  const SlowControl = control.service('slow', {
    setupDeadlineMs: 10_000,
    async setup(_deps, { onDispose }) { onDispose(() => controlEvents.push('cleanup')); await controlGate.promise; return {} },
  })
  const ControlEntry = control.entry({ requires: { slow: SlowControl } })
  const controlRuntime = createRuntime({ services: [SlowControl], limits: { disposalGraceMs: 20 }, diagnostics: { onEvent: event => controlEvents.push(event.type) } })
  const controlEnv = await controlRuntime.enter(ControlEntry)
  void controlEnv.deps.slow.load().catch(() => undefined)
  await sleep(2)
  const controlError = await controlEnv.dispose().catch(error => error)
  assert.ok(controlError.errors.some(item => item.code === 'UNSETTLED_ATTEMPT'))
  assert.equal(controlEnv.state, 'disposing')
  assert.ok(controlEvents.includes('attempt-abandoned'))
  controlGate.resolve()
  await waitFor(() => controlEnv.state === 'disposed')
  assert.ok(controlEvents.includes('cleanup'))
  await controlRuntime.dispose()
})

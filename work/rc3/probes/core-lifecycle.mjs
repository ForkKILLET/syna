// Independent-audit probes, core lifecycle (L1, L2, L2b, L3), reconstructed from
// SYNA_RC3_EXECUTION_PROMPT.md §2.1–2.3 because work/rc3/audit/ was not present in
// the workspace (see work/rc3/BASELINE.md). Each probe asserts that the DEFECT is
// present, exactly as the audit's probes do; they are the baseline, not tests.
// Run: node --expose-gc work/rc3/probes/core-lifecycle.mjs
import { createRuntime, definePackage } from '../../../packages/core/dist/index.js'

const makeDefine = id => definePackage({ name: `@rc3-probe/${id.replaceAll('.', '-')}`, version: '1.0.0', syna: { id } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** L1: the cleanup of a Ready slot is awaited without any bound, so one hung onDispose stops the whole close. */
async function probeL1() {
  const define = makeDefine('rc3.probe.l1')
  const Hanging = define.service('hanging', {
    setup(_deps, { onDispose }) {
      onDispose(() => new Promise(() => undefined)) // never settles, ignores the stop signal
      return { ok: true }
    },
  })
  const Entry = define.entry({ requires: { hanging: Hanging } })
  const runtime = createRuntime({ services: [Hanging], limits: { disposalGraceMs: 50 } })
  const env = await runtime.enter(Entry)
  await env.deps.hanging.load()
  const started = Date.now()
  const outcome = await Promise.race([
    env.dispose().then(() => 'fulfilled', error => `rejected:${error?.name}`),
    sleep(1_000).then(() => 'still-waiting'),
  ])
  return {
    id: 'L1',
    title: 'a hung Ready-slot cleanup is not bounded by the disposal grace',
    reproduced: outcome === 'still-waiting',
    detail: `grace 50 ms; dispose() ${outcome} after ${Date.now() - started} ms; env.state=${env.state}`,
  }
}

/** L2: a cleanup that throws while the close discards a late result reaches neither dispose() nor an event. */
async function probeL2() {
  const define = makeDefine('rc3.probe.l2')
  const events = []
  const gate = deferred()
  const Late = define.service('late', {
    setup(_deps, { onDispose }) {
      onDispose(() => { throw new Error('cleanup during close failed') })
      return gate.promise
    },
  })
  const Entry = define.entry({ requires: { late: Late } })
  const runtime = createRuntime({
    services: [Late],
    limits: { disposalGraceMs: 300 },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  const waiter = env.deps.late.load().then(() => 'resolved', error => error)
  await sleep(5)
  const disposal = env.dispose().then(() => 'fulfilled', error => error)
  await sleep(5)
  gate.resolve({ instance: true }) // settles inside the grace: the result is discarded and the cleanup throws
  const closed = await disposal
  const waiterOutcome = await waiter
  await runtime.dispose().catch(() => undefined)
  const reported = closed instanceof AggregateError
  return {
    id: 'L2',
    title: 'a rollback cleanup that throws inside the close window is not reported by dispose()',
    reproduced: !reported && !events.includes('attempt-succeeded-late'),
    detail: `dispose() ${reported ? 'rejected' : 'fulfilled'}; events=[${events.join(', ')}]; the waiter alone saw it: ${waiterOutcome instanceof AggregateError}`,
  }
}

/** L2b: with the waiter gone (cancelled), the same failure is invisible everywhere. */
async function probeL2b() {
  const define = makeDefine('rc3.probe.l2b')
  const events = []
  const gate = deferred()
  const Late = define.service('late', {
    setup(_deps, { onDispose }) {
      onDispose(() => { throw new Error('cleanup during close failed, nobody waiting') })
      return gate.promise
    },
  })
  const Entry = define.entry({ requires: { late: Late } })
  const runtime = createRuntime({
    services: [Late],
    limits: { disposalGraceMs: 300 },
    diagnostics: { onEvent: event => events.push(event.type) },
  })
  const env = await runtime.enter(Entry)
  const controller = new AbortController()
  const waiter = env.deps.late.load({ signal: controller.signal }).then(() => 'resolved', error => error?.code ?? error)
  await sleep(5)
  controller.abort() // the caller gave up: LOAD_CANCELLED, the attempt keeps running
  const cancelled = await waiter
  const disposal = env.dispose().then(() => 'fulfilled', error => error)
  await sleep(5)
  gate.resolve({ instance: true })
  const closed = await disposal
  await sleep(20)
  await runtime.dispose().catch(() => undefined)
  return {
    id: 'L2b',
    title: 'with the waiter gone the same cleanup failure is visible nowhere',
    reproduced: closed === 'fulfilled' && !events.includes('attempt-succeeded-late') && !events.includes('attempt-failed-late'),
    detail: `waiter=${cancelled}; dispose() ${closed === 'fulfilled' ? 'fulfilled' : 'rejected'}; events=[${events.join(', ')}]`,
  }
}

/**
 * L3: while the raw setup Promise of an abandoned attempt is still pending, the
 * ledger holds the closed Env's whole graph (its unrelated Input payload included).
 * Control group: an Env closed with nothing outstanding is collected.
 */
async function probeL3() {
  if (typeof globalThis.gc !== 'function') throw new Error('run with --expose-gc')
  const define = makeDefine('rc3.probe.l3')
  const Payload = define.input('payload')
  const hold = []
  const Pending = define.service('pending', {
    // Not an async function and it captures nothing: only the Runtime's own
    // references can retain anything here.
    setup(_deps, { onDispose }) {
      onDispose(() => undefined)
      return new Promise(resolve => { hold.push(resolve) })
    },
  })
  const Quiet = define.service('quiet', { setup() { return { ok: true } } })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { pending: Pending, payload: Payload }, parameters: { payload: Payload } })
  const Control = define.entry('control', { requires: { quiet: Quiet, payload: Payload }, parameters: { payload: Payload } })
  const runtime = createRuntime({ services: [Pending, Quiet], limits: { disposalGraceMs: 20 } })
  const root = await runtime.enter(Root)

  let leaking = await root.enter(Child, { payload: { marker: new Uint8Array(1 << 16) } })
  void leaking.deps.pending.load().catch(() => undefined)
  await sleep(5)
  await leaking.dispose()
  let control = await root.enter(Control, { payload: { marker: new Uint8Array(1 << 16) } })
  await control.deps.quiet.load()
  await control.dispose()

  const leakingRef = new WeakRef(leaking)
  const leakingPayloadRef = new WeakRef(leaking.deps.payload.read())
  const controlRef = new WeakRef(control)
  const ledger = runtime.inspect().unsettledAttempts.length
  leaking = undefined
  control = undefined
  for (let round = 0; round < 8; round += 1) {
    globalThis.gc()
    await sleep(20)
  }
  const envAlive = leakingRef.deref() !== undefined
  const payloadAlive = leakingPayloadRef.deref() !== undefined
  const controlAlive = controlRef.deref() !== undefined
  for (const resolve of hold) resolve({})
  await sleep(20)
  await runtime.dispose().catch(() => undefined)
  return {
    id: 'L3',
    title: 'the ledger retains the closed Env graph through attempt.slot.ownerEnv',
    reproduced: envAlive && !controlAlive,
    detail: `ledger=${ledger}; closed Env reachable: ${envAlive}; its Input payload reachable: ${payloadAlive}; control Env reachable: ${controlAlive}`,
  }
}

const probes = [probeL1, probeL2, probeL2b, probeL3]
let failed = 0
for (const probe of probes) {
  const result = await probe()
  if (!result.reproduced) failed += 1
  console.log(`PROBE ${result.id} ${result.reproduced ? 'REPRODUCED' : 'NOT-REPRODUCED'} — ${result.title}`)
  console.log(`    ${result.detail}`)
}
console.log(`core probes: ${probes.length - failed}/${probes.length} reproduced`)
process.exit(failed === 0 ? 0 : 1)

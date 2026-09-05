// Issue 1b / 4b: cancellation paths under --unhandled-rejections=strict; every case catches its own cancellation.
import { createRuntime, definePackage, loadAll } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p2', version: '1.0.0', syna: { id: 'probe.p2' } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason?.code ?? reason?.message ?? String(reason)) })
const c = process.argv[2]
const report = (name) => { console.log(`[${c}] ${name}: unhandled=${JSON.stringify(unhandled)}`) }

if (c === 'A') {
  // caller aborts while attempt runs; attempt then fails
  const gate = deferred()
  const Svc = define.service({ async setup() { await gate.promise; throw new Error('late failure') } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  const ac = new AbortController()
  const p = env.deps.svc.load({ signal: ac.signal })
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  gate.resolve()
  await sleep(20)
  await runtime.dispose().catch(() => {})
  report('abort-then-fail')
}
if (c === 'B') {
  // abort during retry backoff, then owner dispose during backoff
  const Svc = define.service({ failure: { attempts: 3, delayMs: 200 }, async setup() { throw new Error('boom') } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  const ac = new AbortController()
  const p = env.deps.svc.load({ signal: ac.signal })
  await sleep(10)
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  await env.dispose().catch(e => console.log('dispose', e.message))
  await sleep(30)
  await runtime.dispose().catch(() => {})
  report('abort-in-backoff-then-dispose')
}
if (c === 'C') {
  // abort during recovery cooldown; then dispose during cooldown
  const Svc = define.service({ failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 200 }, async setup() { throw new Error('boom') } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  await env.deps.svc.load().catch(() => {})
  const ac = new AbortController()
  const p = env.deps.svc.load({ signal: ac.signal })
  const q = env.deps.svc.load()
  await sleep(10)
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  await env.dispose().catch(e => console.log('dispose', e.message))
  await q.catch(e => console.log('other waiter', e.code))
  await sleep(30)
  await runtime.dispose().catch(() => {})
  report('abort-in-cooldown-then-dispose')
}
if (c === 'D') {
  // setup passes the owner signal to a dependency load, catches LOAD_CANCELLED, returns degraded; owner disposes meanwhile
  const gate = deferred()
  const Dep = define.service('dep', { async setup() { await gate.promise; return { dep: true } } })
  const Consumer = define.service('consumer', {
    requires: { dep: Dep },
    async setup({ dep }, { signal }) {
      try { await dep.load({ signal }) } catch (e) { console.log('setup caught', e.code) }
      return { degraded: true }
    },
  })
  const Entry = define.entry({ requires: { consumer: Consumer } })
  const runtime = createRuntime({ services: [Dep, Consumer], disposal: { graceMs: 30 } })
  const env = await runtime.enter(Entry)
  const p = env.deps.consumer.load()
  await sleep(10)
  await env.dispose().catch(e => console.log('dispose', e.message.slice(0, 80)))
  await p.then(v => console.log('consumer', v), e => console.log('consumer rejected', e.code))
  gate.resolve()
  await sleep(30)
  await runtime.dispose().catch(() => {})
  report('owner-signal-inside-setup')
}
if (c === 'E') {
  // loadAll with signal; abort; attempts fail later
  const gate = deferred()
  const A = define.service('a', { async setup() { await gate.promise; throw new Error('a failed') } })
  const B = define.service('b', { async setup() { await gate.promise; throw new Error('b failed') } })
  const Entry = define.entry({ requires: { a: A, b: B } })
  const runtime = createRuntime({ services: [A, B] })
  const env = await runtime.enter(Entry)
  const ac = new AbortController()
  const p = loadAll({ a: env.deps.a, b: env.deps.b }, { signal: ac.signal })
  await sleep(5)
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  gate.resolve()
  await sleep(20)
  await runtime.dispose().catch(() => {})
  report('loadAll-abort')
}
if (c === 'F') {
  // caller aborts; then the owner closes and abandons the attempt (unsettled outcome)
  const gate = deferred()
  const Svc = define.service({ async setup() { await gate.promise; return {} } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc], disposal: { graceMs: 20 } })
  const env = await runtime.enter(Entry)
  const ac = new AbortController()
  const p = env.deps.svc.load({ signal: ac.signal })
  await sleep(5)
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  await env.dispose().catch(e => console.log('dispose', e.errors?.map(x => x.code)))
  gate.resolve()
  await sleep(20)
  await runtime.dispose().catch(e => console.log('runtime dispose', e.message.slice(0, 60)))
  report('abort-then-abandon')
}
if (c === 'G') {
  // abort of a waiter that joined a *recovery* sequence while the sequence is in its retry delay
  const Svc = define.service({ failure: { attempts: 2, delayMs: 100, afterExhaustion: 'retry-on-next-load', cooldownMs: 1 }, async setup() { throw new Error('boom') } })
  const Entry = define.entry({ requires: { svc: Svc } })
  const runtime = createRuntime({ services: [Svc] })
  const env = await runtime.enter(Entry)
  await env.deps.svc.load().catch(() => {})
  await sleep(5)
  const ac = new AbortController()
  const p = env.deps.svc.load({ signal: ac.signal })
  await sleep(20)
  ac.abort()
  await p.catch(e => console.log('caught', e.code))
  await sleep(150)
  await runtime.dispose().catch(() => {})
  report('abort-recovery-waiter')
}
if (c === 'H') {
  // pre-aborted signal on dormant + on failed + on ready + preload after
  const Svc = define.service({ async setup() { throw new Error('boom') } })
  const Ok = define.service('ok', { async setup() { return {} } })
  const Entry = define.entry({ requires: { svc: Svc, ok: Ok } })
  const runtime = createRuntime({ services: [Svc, Ok] })
  const env = await runtime.enter(Entry)
  const aborted = AbortSignal.abort()
  await env.deps.svc.load({ signal: aborted }).catch(e => console.log('caught', e.code))
  await env.deps.svc.load().catch(e => console.log('caught', e.message))
  await env.deps.svc.load({ signal: aborted }).catch(e => console.log('caught', e.code))
  await env.deps.ok.load({ signal: aborted }).catch(e => console.log('caught', e.code))
  env.deps.svc.preload()
  await sleep(10)
  await runtime.dispose().catch(() => {})
  report('pre-aborted')
}

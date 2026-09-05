// Hypotheses that were tested and turned out fine (controls), plus small observations.
//  C1 dispose() before the deadline, deadline fires inside the grace, raw settles within the remaining
//     grace: no UNSETTLED_ATTEMPT, Env disposed, late-setup-result, cleanup ran.
//  C2 cancellation paths under --unhandled-rejections=strict: aborted signal during a running attempt,
//     during recovery cooldown, on a failed sticky slot; caller-side catches leave no unhandled rejection.
//  C3 recovery cooldown cancelled by owner disposal; dormant materialization refused after closing.
//  C4 BoundEntry check()/explain() while the anchor activates; enter() -> OWNER_NOT_READY; after the
//     anchor's bounded close -> INVALID_ENV_STATE.
//  C5 lineage anchors: plan-template keys separate anchored / unanchored gap Envs in both orders
//     (re-run of the third-round shape) and check() publishes no anchor.
//  C6 range candidates must provide the origin's Contracts (INCOMPATIBLE_IMPLEMENTATION, backtrackable
//     in check()), and an admitted covering revision beats the private origin.
//  O1 observation: check()/explain() consume slot ids (not Env ids); load({signal: aborted}) on a
//     synthetic root ref (C.all / Entry) resolves instead of LOAD_CANCELLED.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, waitFor } from './_harness.mjs'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../../../packages/core/dist/index.js', import.meta.url))

await main(async () => {
  // C1
  {
    const define = makeDefine('audit3.c1')
    const gate = deferred()
    const started = deferred()
    const events = []
    const Slow = define.service('slow', { setupDeadlineMs: 20, async setup(_d, { onDispose }) { onDispose(() => events.push('cleanup')); started.resolve(); await gate.promise; return {} } })
    const Entry = define.entry({ requires: { slow: Slow } })
    const runtime = createRuntime({ services: [Slow], disposal: { graceMs: 400 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    const load = env.deps.slow.load(); void load.catch(() => undefined)
    await started.promise
    const closing = env.dispose()
    setTimeout(() => gate.resolve(), 100) // deadline (20 ms) fires inside the grace, raw settles at ~100 ms
    const error = await closing.catch(e => e)
    const loadOutcome = await settle(load)
    check('C1 the close is clean when the late result arrives inside the remaining grace', error === undefined && env.state === 'disposed', { error, state: env.state, events })
    check('C1 the waiter saw INITIALIZATION_TIMEOUT, the late result was cleaned up and reported', loadOutcome.error?.code === 'INITIALIZATION_TIMEOUT' && events.includes('cleanup') && events.includes('late-setup-result') && !events.includes('attempt-abandoned'), { code: loadOutcome.error?.code, events })
    check('C1 ledger empty, slot disposed', runtime.inspect().unsettledAttempts.length === 0 && env.inspect().nodes[0].state === 'disposed', env.inspect().nodes[0].state)
    await runtime.dispose()
  }

  // C2 (child process, strict unhandled rejections)
  {
    const script = `
      import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
      const define = definePackage({ name: '@audit3/c2', version: '1.0.0', syna: { id: 'audit3.c2' } })
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      let fail = true
      const Flaky = define.service('flaky', { failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 60 }, async setup() { await sleep(30); if (fail) throw new Error('boom'); return { ok: true } } })
      const Sticky = define.service('sticky', { async setup() { await sleep(10); throw new Error('sticky boom') } })
      const Entry = define.entry({ requires: { flaky: Flaky, sticky: Sticky } })
      const runtime = createRuntime({ services: [Flaky, Sticky], disposal: { graceMs: 200 } })
      const env = await runtime.enter(Entry)
      const codes = []
      // running attempt, caller cancels
      const c1 = new AbortController(); const p1 = env.deps.flaky.load({ signal: c1.signal }); setTimeout(() => c1.abort(), 5)
      codes.push(await p1.then(() => 'ok', e => e.code))
      await sleep(40) // the attempt failed; slot failed, cooldown running on next load
      const c2 = new AbortController(); const p2 = env.deps.flaky.load({ signal: c2.signal }); setTimeout(() => c2.abort(), 5)
      codes.push(await p2.then(() => 'ok', e => e.code))
      // sticky failed slot, aborted signal
      await env.deps.sticky.load().catch(() => undefined)
      const c3 = new AbortController(); c3.abort()
      codes.push(await env.deps.sticky.load({ signal: c3.signal }).then(() => 'ok', e => e.code))
      // recovery succeeds later for a plain waiter
      fail = false
      await sleep(80)
      codes.push(await env.deps.flaky.load().then(v => (v.ok ? 'recovered' : 'bad'), e => e.code))
      await env.dispose()
      await runtime.dispose()
      console.log(JSON.stringify(codes))
    `
    const result = await run(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script]).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }))
    check('C2 cancellation paths leave no unhandled rejection (strict mode exits 0)', result.code === 0, result.stderr)
    const codes = result.code === 0 ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : []
    check('C2 codes: LOAD_CANCELLED x2 (running, cooldown), LOAD_CANCELLED (pre-aborted on failed slot), then recovered', JSON.stringify(codes) === JSON.stringify(['LOAD_CANCELLED', 'LOAD_CANCELLED', 'LOAD_CANCELLED', 'recovered']), codes)
  }

  // C3
  {
    const define = makeDefine('audit3.c3')
    const Flaky = define.service('flaky', { failure: { afterExhaustion: 'retry-on-next-load', cooldownMs: 500 }, async setup() { throw new Error('boom') } })
    const Lazy = define.service('lazy', { setup: () => ({}) })
    const Entry = define.entry({ requires: { flaky: Flaky, lazy: Lazy } })
    const runtime = createRuntime({ services: [Flaky, Lazy] })
    const env = await runtime.enter(Entry)
    await env.deps.flaky.load().catch(() => undefined)
    const recovering = env.deps.flaky.load() // cooldown 500 ms
    void recovering.catch(() => undefined)
    await sleep(5)
    const started = Date.now()
    await env.dispose()
    const recoveryOutcome = await settle(recovering)
    const lazyOutcome = await settle(env.deps.lazy.load())
    check('C3 owner disposal cancels a recovery cooldown promptly', Date.now() - started < 200 && recoveryOutcome.error?.code === 'INVALID_ENV_STATE', { elapsed: Date.now() - started, code: recoveryOutcome.error?.code })
    check('C3 no dormant materialization after the owner closed', lazyOutcome.error?.code === 'INVALID_ENV_STATE', lazyOutcome.error?.code)
    await runtime.dispose()
  }

  // C4
  {
    const define = makeDefine('audit3.c4')
    const Tx = define.input('tx')
    const Child = define.entry('child', { requires: {}, parameters: { tx: Tx } })
    const seen = {}
    const gate = deferred()
    const Owner = define.service('owner', {
      eager: true,
      requires: { child: Child },
      async setup({ child }) {
        const bound = await child.load()
        seen.check = await bound.check({ tx: 1 })
        seen.explain = (await bound.explain({ tx: 1 })).ok
        seen.enter = await bound.enter({ tx: 1 }).then(() => 'entered', e => e.code)
        await gate.promise
        return { bound }
      },
    })
    const Host = define.entry('host', { requires: { owner: Owner } })
    const runtime = createRuntime({ services: [Owner] })
    const entering = runtime.enter(Host)
    await waitFor(() => seen.enter !== undefined)
    check('C4 check()/explain() are allowed while the anchor activates; enter() is OWNER_NOT_READY', seen.check?.ok === true && seen.explain === true && seen.enter === 'OWNER_NOT_READY', seen)
    check('C4 planning while activating consumed no Env id and published nothing', runtime.inspect().liveEnvCount === 1, runtime.inspect().liveEnvCount)
    gate.resolve()
    const host = await entering
    const { bound } = await host.deps.owner.load()
    const child = await bound.enter({ tx: 2 })
    check('C4 after Ready the same BoundEntry enters a child anchored at the owner Env', child.inspect().parentId === host.id, child.inspect().parentId)
    await child.dispose()
    await host.dispose()
    const late = await settle(bound.enter({ tx: 3 }))
    check('C4 after the anchor left the tree, enter() is INVALID_ENV_STATE (plain rejection)', late.error?.code === 'INVALID_ENV_STATE', late.error?.code)
    await runtime.dispose()
  }

  // C5 (third-round anchor shape, both orders, plus check() publishes no anchor)
  {
    const build = () => {
      const define = makeDefine('audit3.c5')
      const Cap = define.contract()
      const F1 = makeDefine('audit3.c5.f', '1.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '1.0.0' }) })
      const F2 = makeDefine('audit3.c5.f', '2.0.0').service('f', { uniqueWithin: 'lineage', provides: [Cap], setup: () => ({ version: '2.0.0' }) })
      const G = define.service('g', { provides: [Cap], setup: () => ({ version: 'g' }) })
      const Choice = define.binding('choice', Cap)
      const Pool = define.service('pool', { setup: () => ({}) })
      const Tenant = define.input('tenant')
      const Leaf = define.service('leaf', { requires: { f: F1.range('*') }, setup: async ({ f }) => ({ f: await f.load() }) })
      const App = define.entry('app', { requires: { impl: Choice }, parameters: { choice: Choice } })
      const Site = define.entry('site', { requires: { pool: Pool }, parameters: { tenant: Tenant, choice: Choice } })
      const Request = define.entry('request', { requires: { leaf: Leaf } })
      const runtime = createRuntime({ services: [F1, F2, G, Pool, Leaf] })
      return { runtime, App, Site, Request, F1, G }
    }
    for (const order of [[true, false], [false, true]]) {
      const { runtime, App, Site, Request, F1, G } = build()
      const sites = new Map()
      for (const anchored of order) {
        const app = await runtime.enter(App, { choice: anchored ? F1 : G })
        sites.set(anchored, await app.enter(Site, { tenant: anchored ? 'a' : 'b', choice: G }))
      }
      const observed = {}
      for (const pass of [1, 2]) for (const anchored of order) {
        const explanation = await sites.get(anchored).explain(Request)
        const request = await sites.get(anchored).enter(Request)
        observed[`${anchored ? 'anchored' : 'unanchored'}-${pass}`] = { explain: explanation.ok ? Object.values(explanation.choices).map(v => v.split('@')[1]).join() : explanation.error.code, loaded: (await request.deps.leaf.load()).f.version }
        await request.dispose()
      }
      const ok = order.every(a => [1, 2].every(p => observed[`${a ? 'anchored' : 'unanchored'}-${p}`].loaded === (a ? '1.0.0' : '2.0.0') && observed[`${a ? 'anchored' : 'unanchored'}-${p}`].explain === (a ? '1.0.0' : '2.0.0')))
      check(`C5 anchors in the template key, order ${order.map(a => (a ? 'anchored' : 'unanchored')).join('>')}: explain() and enter() agree with cold plans in both passes`, ok, observed)
      await runtime.dispose()
    }
    // check() publishes no anchor: a check of an F@2 root below an anchor-free lineage, then F@1 by range still works.
    const { runtime, App, Site, Request, G } = build()
    const app = await runtime.enter(App, { choice: G })
    const site = await app.enter(Site, { tenant: 'x', choice: G })
    const checked = await site.check(Request)
    const request = await site.enter(Request)
    check('C5 check() did not anchor F: the following enter() plans as cold (F@2)', checked.ok && (await request.deps.leaf.load()).f.version === '2.0.0')
    await request.dispose(); await runtime.dispose()
  }

  // C6
  {
    const define = makeDefine('audit3.c6')
    const Cap = define.contract('cap')
    const Origin = makeDefine('audit3.c6.h', '1.0.0').service('h', { provides: [Cap], setup: () => ({ v: '1.0.0' }) })
    const Covering = makeDefine('audit3.c6.h', '1.1.0').service('h', { provides: [Cap], setup: () => ({ v: '1.1.0' }) })
    const NotCovering = makeDefine('audit3.c6.h', '1.2.0').service('h', { setup: () => ({ v: '1.2.0' }) })
    const OwnedEntry = define.entry('owned', { requires: { h: Origin.range('*') } })
    const Owner = define.service('owner', { requires: { owned: OwnedEntry }, setup: async ({ owned }) => ({ owned: await owned.load() }) })
    const Host = define.entry('host', { requires: { owner: Owner } })
    const runtime = createRuntime({ services: [Owner, Covering, NotCovering] })
    const host = await runtime.enter(Host)
    const { owned } = await host.deps.owner.load()
    const child = await owned.enter()
    check('C6 an admitted covering revision beats the private origin; the non-covering 1.2.0 is not a candidate', (await child.deps.h.load()).v === '1.1.0')
    await child.dispose(); await host.dispose(); await runtime.dispose()
    const only = createRuntime({ services: [Owner, NotCovering] })
    const host2 = await only.enter(Host)
    const { owned: owned2 } = await host2.deps.owner.load()
    const strict = define.entry('strict', { requires: { h: Origin.range('>=1.2.0') } })
    const explained = await host2.explain(strict)
    check('C6 a range satisfied only by a non-covering revision is INCOMPATIBLE_IMPLEMENTATION in explain() (backtrackable, not thrown)', !explained.ok && explained.error.code === 'INCOMPATIBLE_IMPLEMENTATION' && Array.isArray(explained.error.details.candidates), explained.ok ? 'ok' : explained.error.code)
    const child2 = await owned2.enter()
    check('C6 with only the non-covering revision admitted the range falls back to the origin', (await child2.deps.h.load()).v === '1.0.0')
    await child2.dispose(); await host2.dispose(); await only.dispose()
  }

  // O1 observations
  {
    const define = makeDefine('audit3.o1')
    const Cap = define.contract('cap')
    const Impl = define.service('impl', { provides: [Cap], setup: () => ({}) })
    const Sub = define.entry('sub', {})
    const Entry = define.entry({ requires: { all: Cap.all, sub: Sub, impl: Impl } })
    const runtime = createRuntime({ services: [Impl] })
    for (let i = 0; i < 5; i += 1) await runtime.check(Entry)
    const env = await runtime.enter(Entry)
    const slotIds = env.inspect().nodes.map(n => n.slotId)
    note('O1 slot ids of the first Env after five check() calls (check() consumes slot ids, not Env ids)', { envId: env.id, slotIds })
    const aborted = new AbortController(); aborted.abort()
    const outcomes = {
      all: await settle(env.deps.all.load({ signal: aborted.signal })),
      sub: await settle(env.deps.sub.load({ signal: aborted.signal })),
      impl: await settle(env.deps.impl.load({ signal: aborted.signal })),
    }
    note('O1 load({signal: aborted}) on synthetic refs resolves, on a Service ref rejects LOAD_CANCELLED', Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, v.status === 'rejected' ? v.error.code : 'fulfilled'])))
    await env.dispose(); await runtime.dispose()
  }
}, 30_000)

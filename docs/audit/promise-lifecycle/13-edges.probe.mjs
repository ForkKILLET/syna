// Extra edges: dispose() with setupDeadlineMs: Infinity and a stuck setup; run() callback with a pending background load; dependant cleanup may use dependency; loadAll partial failure.
import { createRuntime, loadAll } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, tick } from './_harness.mjs'

await main(async () => {
  // Case A: setupDeadlineMs: Infinity (documented: "Infinity disables it") + non-cooperative stuck setup -> does dispose() ever return?
  {
    const define = makeDefine('a13.infinite')
    const Stuck = define.service('stuck', { setupDeadlineMs: Infinity, setup: () => new Promise(() => undefined) })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 20 } })
    const env = await runtime.enter(Entry)
    void env.deps.stuck.load().catch(() => undefined)
    await tick()
    const disposal = settle(env.dispose())
    const outcome = await Promise.race([disposal, sleep(400).then(() => 'still-pending')])
    check('A: dispose() with graceMs=20 returns within 400ms when the slot has an infinite deadline', outcome !== 'still-pending', outcome === 'still-pending' ? 'dispose() still pending after 400 ms (graceMs=20)' : outcome)
    note('A: env.state while dispose() is pending', env.state)
    // cannot await disposal (would hang); runtime.dispose() would too. Leave them.
  }
  // Case B: run() callback finishes while a background load is still pending (no setupDeadlineMs) -> run() completion latency.
  {
    const define = makeDefine('a13.run-bg')
    const Slow = define.service('slow', { setup: () => new Promise(() => undefined) })
    const Entry = define.entry({ requires: { slow: Slow } })
    const runtime = createRuntime({ services: [Slow], initialization: { deadlineMs: 300 }, disposal: { graceMs: 20 } })
    const started = Date.now()
    const r = await settle(runtime.run(Entry, async ({ slow }) => { slow.preload(); return 'done' }))
    const elapsed = Date.now() - started
    note('B: run() latency when the callback left a preload() pending (deadlineMs=300, graceMs=20)', elapsed)
    check('B: run() result/rejection', r.status === 'rejected' && r.error?.errors?.some(e => e.code === 'UNSETTLED_ATTEMPT'), r.error ?? r.value)
    check('B: run() returned within ~graceMs, not the full deadline (<150ms)', elapsed < 150, elapsed)
    await runtime.dispose().catch(() => undefined)
  }
  // Case C: dependant cleanup may still use its dependency instance (dependant-first order guarantees the dependency is Ready).
  {
    const define = makeDefine('a13.cleanup-uses-dep')
    const events = []
    const Db = define.service('db', { setup(_d, { onDispose }) { onDispose(() => events.push('db-closed')); return { query: () => 'ok' } } })
    const Repo = define.service('repo', { requires: { db: Db }, setup({ db }, { onDispose }) {
      onDispose(async () => { const r = await settle(db.load()); events.push(`repo-flush:${r.status === 'fulfilled' ? r.value.query() : r.error.code}`) })
      return {}
    } })
    const Entry = define.entry({ requires: { repo: Repo, db: Db } })
    const runtime = createRuntime({ services: [Db, Repo] })
    const env = await runtime.enter(Entry)
    await env.deps.repo.load(); await env.deps.db.load()
    await env.dispose()
    check('C: dependant cleanup could use the dependency; dependency closed afterwards', events.join(',') === 'repo-flush:ok,db-closed', events)
    await runtime.dispose()
  }
  // Case D: loadAll partial failure is a plain catchable rejection; the healthy slot is Ready and reusable.
  {
    const define = makeDefine('a13.loadall')
    const Good = define.service('good', { setup: () => ({ good: true }) })
    const Bad = define.service('bad', { setup: () => { throw new Error('bad') } })
    const Entry = define.entry({ requires: { good: Good, bad: Bad } })
    const runtime = createRuntime({ services: [Good, Bad] })
    const env = await runtime.enter(Entry)
    const r = await settle(loadAll([env.deps.good, env.deps.bad]))
    check('D: loadAll rejects with the failing member error', r.error?.message === 'bad', r.error)
    check('D: healthy member Ready, env still ready', env.state === 'ready' && (await env.deps.good.load()).good === true, env.inspect().nodes.map(n => n.state))
    await runtime.dispose()
  }
}, 6000)

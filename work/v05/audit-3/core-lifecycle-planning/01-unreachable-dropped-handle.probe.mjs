// F-CL3 candidate: SEMANTIC_MODEL §11 / API_REFERENCE / SEMANTIC_CHANGES §4 claim that when the
// raw setup Promise of an abandoned attempt is garbage-collected, "its cleanups run" and
// `attempt-unreachable` is reported. The ledger holds the attempt only through a WeakRef, and the
// only strong path to the attempt is the user's own pending Promise. Hypothesis: when the caller
// keeps NO handle to the closed Env, the attempt (and its registered onDispose cleanups) is
// collected together with the Promise, so nothing runs and nothing is reported.
// The existing regression (v05-review-lifecycle R-3, unreachable case) closes two Envs but only
// asserts `cleanups >= 1` / `unreachableEvents >= 1`, which the kept Env alone satisfies.
// Note: WeakRef.deref() pins its target until the end of the current job, so the dropped Env's
// WeakRef is dereferenced exactly once, after the GC rounds (same technique as the regression test).
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { check, main, note } from './_harness.mjs'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../../../packages/core/dist/index.js', import.meta.url))

const script = `
  import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
  const define = definePackage({ name: '@audit3/unreachable', version: '1.0.0', syna: { id: 'audit3.unreachable' } })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const events = []
  const cleanups = []
  let setups = 0
  const Stuck = define.service('stuck', {
    async setup(_deps, { onDispose }) {
      const label = setups === 0 ? 'dropped' : 'kept'
      setups += 1
      onDispose(() => { cleanups.push(label) })
      await new Promise(() => undefined) // nobody can ever settle this
      return {}
    },
  })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 10 }, initialization: { deadlineMs: 60_000 }, diagnostics: { onEvent: event => events.push(event.type + ':' + event.env) } })
  const root = await runtime.enter(Root)

  // Env 1: handle dropped after its bounded close.
  let dropped = await root.enter(Child)
  const droppedId = dropped.id
  void dropped.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  await dropped.dispose().catch(() => undefined)
  const droppedRef = new WeakRef(dropped)
  dropped = undefined

  // Env 2: handle kept (the case the regression test actually asserts on).
  const kept = await root.enter(Child)
  void kept.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  await kept.dispose().catch(() => undefined)
  const ledgerBefore = runtime.inspect().unsettledAttempts.map(a => a.env)

  const deadline = Date.now() + 6_000
  let rounds = 0
  while (Date.now() < deadline && (kept.state !== 'disposed' || rounds < 12)) {
    globalThis.gc()
    rounds += 1
    await sleep(25)
  }
  await sleep(100)
  console.log(JSON.stringify({
    droppedId,
    keptId: kept.id,
    ledgerBefore,
    droppedCollected: droppedRef.deref() === undefined,
    keptState: kept.state,
    cleanups,
    unreachableEvents: events.filter(e => e.startsWith('attempt-unreachable')),
    ledgerAfter: runtime.inspect().unsettledAttempts.map(a => a.env),
    rounds,
  }))
  await runtime.dispose().catch(() => undefined)
`

await main(async () => {
  const result = await run(process.execPath, ['--expose-gc', '--unhandled-rejections=strict', '--input-type=module', '-e', script])
    .then(r => ({ code: 0, ...r }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  check('child process exited 0', result.code === 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  note('raw child output', out)
  check('both attempts were in the ledger after the bounded close', out.ledgerBefore.length === 2, out.ledgerBefore)
  check('the dropped Env was collected (nothing in the Runtime holds it)', out.droppedCollected)
  check('kept Env: attempt closed as unreachable, state disposed', out.keptState === 'disposed', out.keptState)
  check('kept Env: its onDispose cleanup ran', out.cleanups.includes('kept'), out.cleanups)
  check('kept Env: attempt-unreachable reported', out.unreachableEvents.some(e => e.endsWith(':' + out.keptId)), out.unreachableEvents)
  // The documented behaviour for the dropped Env (SEMANTIC_MODEL §11: "its cleanups run, attempt-unreachable is reported").
  check('dropped Env: its onDispose cleanup ran (documented: cleanups run when the Promise is collected)', out.cleanups.includes('dropped'), out.cleanups)
  check('dropped Env: attempt-unreachable reported (documented)', out.unreachableEvents.some(e => e.endsWith(':' + out.droppedId)), out.unreachableEvents)
  check('ledger is empty afterwards', out.ledgerAfter.length === 0, out.ledgerAfter)
}, 20_000)

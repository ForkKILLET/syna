// Repeat of the "attempt-unreachable" retention question, to decide whether the documented
// behaviour ("its cleanups run, attempt-unreachable is reported" once the setup Promise is
// collected) is deterministic when the caller drops every handle. Two variants, N runs each,
// in fresh child processes with --expose-gc:
//   single : one Env, handle dropped right after its bounded close, then GC rounds.
//   pair   : dropped Env then a kept Env (shape of the regression test R-3).
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { check, main, note } from './_harness.mjs'

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../../../packages/core/dist/index.js', import.meta.url))

const script = variant => `
  import { createRuntime, definePackage } from ${JSON.stringify(DIST)}
  const define = definePackage({ name: '@audit3/unreachable-repeat', version: '1.0.0', syna: { id: 'audit3.unreachable-repeat' } })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const events = []
  const cleanups = []
  let setups = 0
  const Stuck = define.service('stuck', {
    async setup(_deps, { onDispose }) {
      const label = setups === 0 ? 'dropped' : 'kept'
      setups += 1
      onDispose(() => { cleanups.push(label) })
      await new Promise(() => undefined)
      return {}
    },
  })
  const Root = define.entry('root', {})
  const Child = define.entry('child', { requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 10 }, diagnostics: { onEvent: event => events.push(event.type + ':' + event.env) } })
  const root = await runtime.enter(Root)
  let dropped = await root.enter(Child)
  const droppedId = dropped.id
  void dropped.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  await dropped.dispose().catch(() => undefined)
  const droppedRef = new WeakRef(dropped)
  dropped = undefined
  let kept
  if (${JSON.stringify(variant)} === 'single-yield') await sleep(0)
  if (${JSON.stringify(variant)} === 'pair') {
    kept = await root.enter(Child)
    void kept.deps.stuck.load().catch(() => undefined)
    await sleep(5)
    await kept.dispose().catch(() => undefined)
  }
  for (let round = 0; round < 15; round += 1) { globalThis.gc(); await sleep(20) }
  await sleep(100)
  console.log(JSON.stringify({
    droppedCollected: droppedRef.deref() === undefined,
    droppedCleanup: cleanups.includes('dropped'),
    droppedEvent: events.includes('attempt-unreachable:' + droppedId),
    keptState: kept?.state,
    keptCleanup: cleanups.includes('kept'),
    ledger: runtime.inspect().unsettledAttempts.length,
  }))
  await runtime.dispose().catch(() => undefined)
`

await main(async () => {
  for (const variant of ['single', 'single-yield', 'pair']) {
    const outcomes = []
    for (let i = 0; i < 6; i += 1) {
      const result = await run(process.execPath, ['--expose-gc', '--unhandled-rejections=strict', '--input-type=module', '-e', script(variant)])
        .then(r => ({ code: 0, ...r }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
      if (result.code !== 0) { outcomes.push({ error: result.stderr }); continue }
      outcomes.push(JSON.parse(result.stdout.trim().split('\n').at(-1)))
    }
    note(`${variant}: per-run outcomes`, outcomes)
    check(`${variant}: the dropped Env is collected in every run`, outcomes.every(o => o.droppedCollected), outcomes.map(o => o.droppedCollected))
    check(`${variant}: the dropped attempt's cleanup ran and attempt-unreachable fired in every run (documented)`, outcomes.every(o => o.droppedCleanup && o.droppedEvent), outcomes.map(o => [o.droppedCleanup, o.droppedEvent]))
    check(`${variant}: ledger empty at the end in every run`, outcomes.every(o => o.ledger === 0), outcomes.map(o => o.ledger))
  }
}, 120_000)

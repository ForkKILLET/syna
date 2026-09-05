// Documentation check: API_REFERENCE says "a close is bounded by one grace period regardless of
// setupDeadlineMs" and "The close is bounded by one grace period; when it ends the Env has left the
// tree". disposeEnv() waits for the children's closes BEFORE giving its own attempts the grace, so a
// chain of Envs each holding a stuck attempt closes in depth x grace, not one grace. The stop signal
// reaches every level at broadcast time, so the extra waiting is pure serialization.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, main, makeDefine, note, sleep } from './_harness.mjs'

await main(async () => {
  const define = makeDefine('audit3.tree-close')
  const graceMs = 150
  const Stuck = define.service('stuck', { async setup() { await new Promise(() => undefined) } })
  const Level = define.entry('level', { requires: { stuck: Stuck } })
  const runtime = createRuntime({ services: [Stuck], disposal: { graceMs } })

  const root = await runtime.enter(Level)
  const mid = await root.enter(Level, { scope: { fresh: [Stuck] } })
  const leaf = await mid.enter(Level, { scope: { fresh: [Stuck] } })
  for (const env of [root, mid, leaf]) void env.deps.stuck.load().catch(() => undefined)
  await sleep(5)
  const owners = new Set([root, mid, leaf].map(env => env.inspect().nodes.find(n => n.kind === 'service').ownerEnvId))
  check('each level owns its own stuck slot', owners.size === 3, [...owners])

  const started = Date.now()
  const error = await root.dispose().catch(e => e)
  const elapsed = Date.now() - started
  note('root.dispose() elapsed ms for a 3-level chain', { elapsed, graceMs })
  check('dispose() of the root reported the abandoned attempts', error instanceof AggregateError, error)
  check('the close of a 3-level tree is bounded by ONE grace period (documented)', elapsed < 2 * graceMs, { elapsed, bound: 2 * graceMs })
  await runtime.dispose().catch(() => undefined)
}, 10_000)

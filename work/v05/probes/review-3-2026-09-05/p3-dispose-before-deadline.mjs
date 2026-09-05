// C4: dispose() before a setup deadline that fires inside the grace must still report the running attempt.
import { createRuntime, definePackage } from '../../../../packages/core/dist/index.js'
const define = definePackage({ name: '@probe/p3', version: '1.0.0', syna: { id: 'probe3.deadline' } })
const deferred = () => { let resolve; const promise = new Promise(res => { resolve = res }); return { promise, resolve } }
const gate = deferred()
const started = deferred()
const events = []
const Slow = define.service('slow', {
  setupDeadlineMs: 10,
  async setup(_deps, { onDispose }) { onDispose(() => events.push('cleanup')); started.resolve(); await gate.promise; return {} },
})
const Entry = define.entry({ requires: { slow: Slow } })
const runtime = createRuntime({ services: [Slow], disposal: { graceMs: 300 }, diagnostics: { onEvent: event => events.push(event.type) } })
const env = await runtime.enter(Entry)
void env.deps.slow.load().catch(() => undefined)
await started.promise
const error = await env.dispose().catch(error => error)
const reported = error instanceof AggregateError && error.errors.some(item => item.code === 'UNSETTLED_ATTEMPT')
let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }
check('the close reports UNSETTLED_ATTEMPT', reported, error?.errors?.map(item => item.code) ?? String(error))
check('the Env stays disposing while the raw setup runs', env.state === 'disposing', env.state)
check('attempt-abandoned was emitted', events.includes('attempt-abandoned'), events)
check('the attempt is in the ledger', runtime.inspect().unsettledAttempts.length === 1, runtime.inspect().unsettledAttempts.length)
gate.resolve()
await new Promise(resolve => setTimeout(resolve, 50))
check('after the setup settles the Env is disposed and cleanup ran', env.state === 'disposed' && events.includes('cleanup'), { state: env.state, events })
await runtime.dispose()
process.exitCode = failed === 0 ? 0 : 1

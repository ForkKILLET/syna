// Attack 5: retry policy attempts:3 delayMs:200 -> dispose during backoff; throwing rollback cleanup stops the sequence; cooldown recovery cancelled by dispose.
import { createRuntime } from '../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, waitFor } from './_harness.mjs'

await main(async () => {
  // Case A: dispose during backoff -> prompt return, no further attempt, cleanups of failed attempt already ran.
  {
    const define = makeDefine('a5.backoff')
    let attempts = 0
    const events = []
    const Flaky = define.service('flaky', {
      failure: { attempts: 3, delayMs: 200 },
      setup(_d, { onDispose }) { attempts += 1; onDispose(() => events.push(`cleanup-${attempts}`)); throw new Error(`fail-${attempts}`) },
    })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky] })
    const env = await runtime.enter(Entry)
    const loading = settle(env.deps.flaky.load())
    await waitFor(() => attempts === 1)
    await sleep(10)
    const started = Date.now()
    await env.dispose()
    const elapsed = Date.now() - started
    const result = await loading
    check('A: dispose during backoff returns promptly (<100ms)', elapsed < 100, elapsed)
    check('A: waiter rejected with INVALID_ENV_STATE cancellation', result.error?.code === 'INVALID_ENV_STATE' && /cancelled/.test(result.error.message), result.error)
    await sleep(250)
    check('A: no further attempt after disposal', attempts === 1, attempts)
    check('A: rollback cleanup of failed attempt ran', events.includes('cleanup-1'), events)
    await runtime.dispose()
  }
  // Case B: cleanup registered in a failed attempt throws -> sequence stops, AggregateError with business error + rollback error.
  {
    const define = makeDefine('a5.rollback-fails')
    let attempts = 0
    const Flaky = define.service('flaky', {
      failure: { attempts: 3, delayMs: 5 },
      setup(_d, { onDispose }) {
        attempts += 1
        onDispose(() => { throw new Error(`rollback-${attempts}`) })
        onDispose(() => { /* second cleanup must still run */ })
        throw new Error(`fail-${attempts}`)
      },
    })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky] })
    const env = await runtime.enter(Entry)
    const result = await settle(env.deps.flaky.load())
    check('B: rejected with AggregateError', result.error instanceof AggregateError, result.error)
    check('B: AggregateError keeps business error and rollback error', result.error?.errors?.length === 2 && /fail-1/.test(result.error.errors[0].message) && /rollback-1/.test(result.error.errors[1].message), result.error?.errors?.map(e => e.message))
    check('B: cause is the business error', result.error?.cause?.message === 'fail-1', result.error?.cause?.message)
    await sleep(30)
    check('B: no retry after failed rollback', attempts === 1, attempts)
    const again = await settle(env.deps.flaky.load())
    check('B: slot sticky with the same AggregateError', again.error === result.error, again.error === result.error)
    check('B: slot state failed', env.inspect().nodes[0].state === 'failed', env.inspect().nodes[0].state)
    await runtime.dispose()
  }
  // Case C: retry succeeds on attempt 2; retry-on-next-load with cooldown; dispose during cooldown cancels.
  {
    const define = makeDefine('a5.cooldown')
    let attempts = 0
    const Flaky = define.service('flaky', {
      failure: { attempts: 1, afterExhaustion: 'retry-on-next-load', cooldownMs: 300 },
      setup() { attempts += 1; throw new Error(`fail-${attempts}`) },
    })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky] })
    const env = await runtime.enter(Entry)
    await settle(env.deps.flaky.load())
    const recovering = settle(env.deps.flaky.load())   // enters cooldown sleep
    const recovering2 = settle(env.deps.flaky.load())  // joins same recovery
    await sleep(10)
    const started = Date.now()
    await env.dispose()
    const r = await recovering
    const r2 = await recovering2
    check('C: recovery cooldown cancelled promptly by dispose', Date.now() - started < 100 && r.error?.code === 'INVALID_ENV_STATE' && /cancelled/.test(r.error.message), r.error)
    check('C: joined recovery waiter also cancelled', r2.error?.code === 'INVALID_ENV_STATE', r2.error?.code)
    await sleep(320)
    check('C: no attempt started after disposal', attempts === 1, attempts)
    await runtime.dispose()
  }
  // Case D: attempt 1 times out (unsettled) with attempts:3 -> no overlapping retry.
  {
    const define = makeDefine('a5.timeout-no-retry')
    let attempts = 0
    const Flaky = define.service('flaky', {
      setupDeadlineMs: 20,
      failure: { attempts: 3, delayMs: 5 },
      setup() { attempts += 1; return new Promise(() => undefined) },
    })
    const Entry = define.entry({ requires: { flaky: Flaky } })
    const runtime = createRuntime({ services: [Flaky], disposal: { graceMs: 10 } })
    const env = await runtime.enter(Entry)
    const r = await settle(env.deps.flaky.load())
    await sleep(60)
    check('D: timed-out attempt is not retried (would overlap)', r.error?.code === 'INITIALIZATION_TIMEOUT' && attempts === 1, { code: r.error?.code, attempts })
    await env.dispose().catch(() => undefined)
    await runtime.dispose().catch(() => undefined)
  }
})

// Ledger / state consistency around rollbacks that outlive the disposal grace.
// (a) An attempt whose setup REJECTED before the close but whose onDispose rollback is still running
//     when the grace ends: settleSlot() sees a pending sequence with a 'running' attempt, marks the slot
//     'abandoned', reports UNSETTLED_ATTEMPT ("still running") and attempt-abandoned. The attempt was
//     never registered in the ledger (raw Promise settled), `slot.unsettledAttempt` is set and never
//     cleared, and the slot never leaves 'abandoned' even after the Env is 'disposed'.
// (b) After a late settlement, handleLateSettlement() deletes the ledger record BEFORE the late
//     cleanup runs, so while the Env is still 'disposing' (finalization waits for the cleanup) the
//     ledger is empty and runtime.dispose() reports nothing.
import { createRuntime } from '../../../../packages/core/dist/index.js'
import { check, deferred, main, makeDefine, note, settle, sleep, waitFor } from './_harness.mjs'

await main(async () => {
  // (a) slow rollback after a failed setup
  {
    const define = makeDefine('audit3.slow-rollback')
    const rollbackGate = deferred()
    const events = []
    const Failing = define.service('failing', {
      async setup(_deps, { onDispose }) {
        onDispose(async () => { events.push('rollback-start'); await rollbackGate.promise; events.push('rollback-end') })
        throw new Error('setup failed')
      },
    })
    const Entry = define.entry({ requires: { failing: Failing } })
    const runtime = createRuntime({ services: [Failing], disposal: { graceMs: 40 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    const load = env.deps.failing.load()
    void load.catch(() => undefined)
    await waitFor(() => events.includes('rollback-start'))
    const error = await env.dispose().catch(e => e)
    const report = error instanceof AggregateError ? error.errors.find(e => e.code === 'UNSETTLED_ATTEMPT') : undefined
    note('close report for a failed setup whose rollback is slow', { codes: error instanceof AggregateError ? error.errors.map(e => e.code) : String(error), events, envState: env.state, slotState: env.inspect().nodes[0].state, ledger: runtime.inspect().unsettledAttempts.length })
    check('(a) the close waited only one grace and reported the slow rollback as an abandoned attempt', report !== undefined && env.state === 'disposing', { report: report?.message, state: env.state })
    check('(a) the report claims the setup attempt is "still running", although its setup already failed', report !== undefined && /still running/.test(report.message), report?.message)
    check('(a) the abandoned attempt IS listed in inspect().unsettledAttempts while the Env is disposing for it (expected by the docs; the code never registers an attempt whose raw Promise already settled)', runtime.inspect().unsettledAttempts.length === 1, runtime.inspect().unsettledAttempts)
    rollbackGate.resolve()
    await waitFor(() => env.state === 'disposed')
    const slotState = env.inspect().nodes[0].state
    check('(a) once the rollback finished and the Env is disposed, its slot is disposed too', slotState === 'disposed', { envState: env.state, slotState })
    const loadOutcome = await settle(load)
    check('(a) the original waiter got the setup failure', loadOutcome.status === 'rejected' && loadOutcome.error.message === 'setup failed', loadOutcome.error)
    await runtime.dispose().catch(() => undefined)
  }

  // (b) ledger empty during a late cleanup
  {
    const define = makeDefine('audit3.late-cleanup-ledger')
    const setupGate = deferred()
    const cleanupGate = deferred()
    const events = []
    const Stuck = define.service('stuck', {
      async setup(_deps, { onDispose }) {
        onDispose(async () => { events.push('late-cleanup-start'); await cleanupGate.promise; events.push('late-cleanup-end') })
        await setupGate.promise
        return {}
      },
    })
    const Entry = define.entry({ requires: { stuck: Stuck } })
    const runtime = createRuntime({ services: [Stuck], disposal: { graceMs: 10 }, diagnostics: { onEvent: e => events.push(e.type) } })
    const env = await runtime.enter(Entry)
    void env.deps.stuck.load().catch(() => undefined)
    await sleep(5)
    await env.dispose().catch(() => undefined)
    check('(b) after the bounded close the attempt is in the ledger and the Env is disposing', runtime.inspect().unsettledAttempts.length === 1 && env.state === 'disposing', { ledger: runtime.inspect().unsettledAttempts.length, state: env.state })
    setupGate.resolve() // late settlement; the late cleanup now blocks on cleanupGate
    await waitFor(() => events.includes('late-cleanup-start'))
    const during = { state: env.state, ledger: runtime.inspect().unsettledAttempts.length, slot: env.inspect().nodes[0].state }
    note('during the late cleanup', during)
    check('(b) the Env stays disposing while its late cleanup runs (documented)', during.state === 'disposing', during)
    check('(b) the ledger still lists the attempt while the Env is disposing for it', during.ledger === 1, during)
    const disposeOutcome = await settle(runtime.dispose())
    check('(b) runtime.dispose() during the late cleanup reports the outstanding attempt', disposeOutcome.status === 'rejected', disposeOutcome.status === 'rejected' ? disposeOutcome.error : 'fulfilled silently')
    cleanupGate.resolve()
    await waitFor(() => env.state === 'disposed')
    check('(b) after the cleanup the Env is disposed', env.state === 'disposed' && events.includes('late-setup-result'), { state: env.state, events })
  }
}, 15_000)

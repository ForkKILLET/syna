import { define } from '../syna.js'
import type { DomainTable } from './domains.js'
import { SiteEnvironmentManager } from './manager.js'

export interface WorkerControl {
  /**
   * Starts the background loop. Must be called by the host after the root Env is
   * Ready. With `domains`, every tick also reloads the domain table so tenants
   * saved after startup are served without a restart.
   */
  start(options?: { readonly intervalMs?: number; readonly domains?: DomainTable }): Promise<void>
  /** Ends the loop and releases the worker world. Rethrows the error that ended a `failed` loop. */
  stop(): Promise<void>
  /** `failed`: a tick threw; the loop ended, its world is released and `lastError` holds the cause. */
  readonly state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
  readonly ticks: number
  /** The error that ended the loop (state `failed`), until the next start(). */
  readonly lastError: unknown
  /** Domain-table reloads that failed; the loop goes on and the previous table stays in use. */
  readonly refreshFailures: number
}

/** The worker's own world: a child of the app Env that the host opens explicitly. */
export const WorkerEntry = define.entry('worker', {
  requires: { sites: SiteEnvironmentManager },
})

/**
 * A control Service, not a never-ending setup. `setup()` returns an initialized
 * controller; the host starts the loop after the root is Ready. The loop runs
 * inside a child Env (WorkerEntry); stop() ends the loop, waits for the current
 * tick, releases the child, and only then may the owner close shared resources.
 * The loop is supervised: a tick that throws ends it in state `failed`, with the
 * error kept for the next stop() (and thus for the owner's cleanup report); it
 * never becomes an unhandled rejection and never leaves the state at `running`.
 */
export const MaintenanceWorker = define.service('maintenance-worker', {
  requires: { worlds: WorkerEntry },
  async setup({ worlds }, { signal, onDispose }): Promise<WorkerControl> {
    const bound = await worlds.load()
    let state: WorkerControl['state'] = 'idle'
    let ticks = 0
    let refreshFailures = 0
    let lastError: unknown
    let loop: Promise<void> | undefined
    let starting: Promise<void> | undefined
    let wake: (() => void) | undefined
    let stopRequested = false
    const current = (): WorkerControl['state'] => state

    const reportFailed = (): never => {
      state = 'stopped'
      throw lastError
    }

    const stop = async (): Promise<void> => {
      if (state === 'idle' || state === 'stopped') { state = 'stopped'; return }
      if (state === 'failed') return reportFailed()
      // A stop() that overlaps start() wins: the loop never begins, the world is released.
      stopRequested = true
      if (state === 'starting') await starting?.catch(() => undefined)
      // `state` may have moved while we awaited; TS keeps the earlier narrowing.
      if (current() === 'stopped') return
      if (current() === 'failed') return reportFailed()
      state = 'stopping'
      wake?.()
      await loop
      if (current() === 'failed') return reportFailed()
      state = 'stopped'
    }
    // The stop signal only starts the wind-down; its outcome (a failed loop
    // included) is reported by the cleanup below, which awaits the same loop.
    signal.addEventListener('abort', () => {
      stopRequested = true
      wake?.()
    }, { once: true })
    onDispose(stop)

    return {
      get state() { return state },
      get ticks() { return ticks },
      get lastError() { return lastError },
      get refreshFailures() { return refreshFailures },
      async start(options = {}) {
        if (state !== 'idle' && state !== 'stopped' && state !== 'failed') throw new Error(`Worker is ${state}.`)
        const intervalMs = options.intervalMs ?? 1_000
        stopRequested = false
        lastError = undefined
        state = 'starting'
        // Opening the worker world requires a Ready owner: calling start() from inside
        // a setup would reject with OWNER_NOT_READY, which is the documented boundary.
        starting = bound.enter().then(async world => {
          if (stopRequested || signal.aborted) {
            await world.dispose()
            state = 'stopped'
            return
          }
          state = 'running'
          runLoop(world, intervalMs, options.domains)
        }, error => {
          state = 'stopped'
          throw error
        })
        await starting
      },
      stop,
    }

    function runLoop(world: Awaited<ReturnType<typeof bound.enter>>, intervalMs: number, domains: DomainTable | undefined): void {
      loop = (async () => {
        let failure: { readonly error: unknown } | undefined
        try {
          const sites = await world.deps.sites.load()
          while (!stopRequested && !signal.aborted) {
            await sites.sweep() // never rejects: closes that fail are reported by the manager
            if (domains) {
              try { await domains.refresh() }
              catch { refreshFailures += 1 }
            }
            ticks += 1
            await new Promise<void>(resolve => {
              wake = resolve
              setTimeout(resolve, intervalMs).unref()
            })
          }
        }
        catch (error) {
          failure = { error }
        }
        // The world is released before the state settles: `failed` means the
        // loop is gone and retains nothing, not "dead but still holding an Env".
        try { await world.dispose() }
        catch (error) { failure ??= { error } }
        if (failure) {
          lastError = failure.error
          state = 'failed'
        }
      })()
    }
  },
})

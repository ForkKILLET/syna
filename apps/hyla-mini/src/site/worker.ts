import { define } from '../syna.js'
import { SiteEnvironmentManager } from './manager.js'

export interface WorkerControl {
  /** Starts the background loop. Must be called by the host after the root Env is Ready. */
  start(options?: { readonly intervalMs?: number }): Promise<void>
  stop(): Promise<void>
  readonly state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped'
  readonly ticks: number
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
 */
export const MaintenanceWorker = define.service('maintenance-worker', {
  requires: { worlds: WorkerEntry },
  async setup({ worlds }, { signal, onDispose }): Promise<WorkerControl> {
    const bound = await worlds.load()
    let state: WorkerControl['state'] = 'idle'
    let ticks = 0
    let loop: Promise<void> | undefined
    let starting: Promise<void> | undefined
    let wake: (() => void) | undefined
    let stopRequested = false

    const stop = async (): Promise<void> => {
      if (state === 'idle' || state === 'stopped') { state = 'stopped'; return }
      // A stop() that overlaps start() wins: the loop never begins, the world is released.
      stopRequested = true
      if (state === 'starting') await starting?.catch(() => undefined)
      // `state` may have moved to 'stopped' while we awaited; TS keeps the earlier narrowing.
      if ((state as WorkerControl['state']) === 'stopped') return
      state = 'stopping'
      wake?.()
      await loop
      state = 'stopped'
    }
    signal.addEventListener('abort', () => { void stop() }, { once: true })
    onDispose(stop)

    return {
      get state() { return state },
      get ticks() { return ticks },
      async start(options = {}) {
        if (state !== 'idle' && state !== 'stopped') throw new Error(`Worker is ${state}.`)
        const intervalMs = options.intervalMs ?? 1_000
        stopRequested = false
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
          runLoop(world, intervalMs)
        }, error => {
          state = 'stopped'
          throw error
        })
        await starting
      },
      stop,
    }

    function runLoop(world: Awaited<ReturnType<typeof bound.enter>>, intervalMs: number): void {
        loop = (async () => {
          try {
            const sites = await world.deps.sites.load()
            while (!stopRequested && !signal.aborted) {
              await sites.sweep()
              ticks += 1
              await new Promise<void>(resolve => {
                wake = resolve
                setTimeout(resolve, intervalMs).unref()
              })
            }
          }
          finally {
            await world.dispose()
          }
        })()
    }
  },
})

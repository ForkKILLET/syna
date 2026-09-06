import { SynaError, type SynaErrorDetails } from '../errors.js'

export type ClosedEnvDetails = SynaErrorDetails['ENV_CLOSED']

/** The refusal every operation meets once its Env, or the owner Env of its slot, is closing or closed. */
export function closedError(message: string, details: ClosedEnvDetails): SynaError<'ENV_CLOSED'> {
  return new SynaError('ENV_CLOSED', message, details)
}

/**
 * Sleeps unless the owner's stop signal fires first. `details` is read when the
 * refusal is built, so it carries the owner's state at that moment.
 */
export function sleepAbortable(
  milliseconds: number,
  signal: AbortSignal,
  message: string,
  details: () => ClosedEnvDetails,
): Promise<void> {
  if (signal.aborted) return Promise.reject(closedError(message, details()))
  if (milliseconds <= 0) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', cancel, { once: true })

    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }

    function finish(): void {
      cleanup()
      resolve()
    }

    function cancel(): void {
      cleanup()
      reject(closedError(message, details()))
    }
  })
}

/**
 * Ends one caller's wait when its signal aborts. The underlying promise is
 * untouched: other waiters and the shared attempt continue.
 */
export function waitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  describe: () => SynaErrorDetails['LOAD_CANCELLED'],
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    // The caller's own wait ends here; the shared promise keeps an observer so a
    // later failure of the attempt is never an unhandled rejection of this copy.
    promise.then(undefined, () => undefined)
    return Promise.reject(new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', describe()))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new SynaError('LOAD_CANCELLED', 'The caller cancelled its wait.', describe()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** Resolves to `true` when the promise settles within the timeout, `false` otherwise. */
export function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  if (!Number.isFinite(milliseconds)) return promise.then(() => true, () => true)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), Math.max(0, milliseconds))
    promise.then(
      () => { clearTimeout(timer); resolve(true) },
      () => { clearTimeout(timer); resolve(true) },
    )
  })
}

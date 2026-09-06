import { SynaError, type SynaErrorDetails } from '../errors.js'

export function abortError(message: string, details: SynaErrorDetails['INVALID_ENV_STATE'] = {}): SynaError<'INVALID_ENV_STATE'> {
  return new SynaError('INVALID_ENV_STATE', message, details)
}

export function assertNotAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw abortError(message)
}

export function sleepAbortable(
  milliseconds: number,
  signal: AbortSignal,
  message: string,
): Promise<void> {
  assertNotAborted(signal, message)
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
      reject(abortError(message))
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

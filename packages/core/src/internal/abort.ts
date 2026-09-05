import { SynaError } from '../errors.js'

export function abortError(message: string): SynaError {
  return new SynaError('INVALID_ENV_STATE', message)
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

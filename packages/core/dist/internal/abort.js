import { SynaError } from '../errors.js';
export function abortError(message) {
    return new SynaError('INVALID_ENV_STATE', message);
}
export function assertNotAborted(signal, message) {
    if (signal.aborted)
        throw abortError(message);
}
export function sleepAbortable(milliseconds, signal, message) {
    assertNotAborted(signal, message);
    if (milliseconds <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(finish, milliseconds);
        signal.addEventListener('abort', cancel, { once: true });
        function cleanup() {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
        }
        function finish() {
            cleanup();
            resolve();
        }
        function cancel() {
            cleanup();
            reject(abortError(message));
        }
    });
}
//# sourceMappingURL=abort.js.map
import { SynaError } from '../errors.js';
export declare function abortError(message: string): SynaError;
export declare function assertNotAborted(signal: AbortSignal, message: string): void;
export declare function sleepAbortable(milliseconds: number, signal: AbortSignal, message: string): Promise<void>;
//# sourceMappingURL=abort.d.ts.map
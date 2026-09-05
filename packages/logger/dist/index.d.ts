export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    readonly messages: readonly string[];
}
export declare const Logger: import("@syna/core").ServiceRevision<Logger>;
//# sourceMappingURL=index.d.ts.map
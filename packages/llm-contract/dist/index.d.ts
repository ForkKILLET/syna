export interface LlmConnector {
    readonly provider: string;
    readonly implementationVersion: string;
    complete(prompt: string): Promise<string>;
}
export declare const LlmConnector: import("@syna/core").Contract<LlmConnector>;
export interface LlmCallContext {
    readonly requestId: string;
    readonly blogId?: string;
}
export declare const LlmCall: import("@syna/core").Input<LlmCallContext>;
//# sourceMappingURL=index.d.ts.map
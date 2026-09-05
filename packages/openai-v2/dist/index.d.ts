import { LlmConnector } from '@syna-demo/llm-contract';
export interface OpenAI extends LlmConnector {
    readonly generation: 'current';
    tokenEstimate(text: string): number;
}
export declare const OpenAI: import("@syna/core").ServiceRevision<OpenAI>;
//# sourceMappingURL=index.d.ts.map
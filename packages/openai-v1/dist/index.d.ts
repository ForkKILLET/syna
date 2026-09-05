import { LlmConnector } from '@syna-demo/llm-contract';
export interface OpenAI extends LlmConnector {
    readonly generation: 'legacy';
}
export declare const OpenAI: import("@syna/core").ServiceRevision<OpenAI>;
//# sourceMappingURL=index.d.ts.map
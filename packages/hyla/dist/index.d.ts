import type { ImplementationCandidate, PersistentImplementationRef } from '@syna/core';
import { LlmConnector } from '@syna-demo/llm-contract';
import { type PostgresOptions } from '@syna-demo/postgres';
export interface Blog {
    readonly id: string;
    readonly title: string;
}
export declare const CurrentBlog: import("@syna/core").Input<Blog>;
export declare const ArticleSummaryLlm: import("@syna/core").Binding<import("@syna/core").Contract<LlmConnector>>;
export interface HylaApplication {
    status(): Promise<{
        readonly databasePool: number;
        readonly databaseUrl: string;
    }>;
}
export declare const HylaApplication: import("@syna/core").ServiceRevision<HylaApplication>;
export interface BlogRuntime {
    describe(): Promise<string>;
    databasePool(): Promise<number>;
}
export declare const BlogRuntime: import("@syna/core").ServiceRevision<BlogRuntime>;
export interface ArticleSummarizer {
    summarize(article: string): Promise<string>;
    provider(): Promise<string>;
}
export declare const ArticleSummarizer: import("@syna/core").ServiceRevision<ArticleSummarizer>;
export interface ProviderPanel {
    list(): Promise<readonly ImplementationCandidate<typeof LlmConnector>[]>;
    run(provider: PersistentImplementationRef<typeof LlmConnector>, prompt: string): Promise<string>;
}
export declare const ProviderPanel: import("@syna/core").ServiceRevision<ProviderPanel>;
export declare const AppEntry: import("@syna/core").EntryDescriptor<{
    readonly app: import("@syna/core").ServiceRevision<HylaApplication>;
}, {
    readonly database: import("@syna/core").Input<PostgresOptions>;
}>;
export declare const BlogEntry: import("@syna/core").EntryDescriptor<{
    readonly blog: import("@syna/core").ServiceRevision<BlogRuntime>;
}, {
    readonly currentBlog: import("@syna/core").Input<Blog>;
    readonly summaryLlm: import("@syna/core").Binding<import("@syna/core").Contract<LlmConnector>>;
}>;
export declare const RequestEntry: import("@syna/core").EntryDescriptor<{
    readonly summarizer: import("@syna/core").ServiceRevision<ArticleSummarizer>;
}, {
    readonly call: import("@syna/core").Input<import("@syna-demo/llm-contract").LlmCallContext>;
}>;
export declare const ProvidersEntry: import("@syna/core").EntryDescriptor<{
    readonly panel: import("@syna/core").ServiceRevision<ProviderPanel>;
}, {
    readonly call: import("@syna/core").Input<import("@syna-demo/llm-contract").LlmCallContext>;
}>;
export type { PostgresOptions };
//# sourceMappingURL=index.d.ts.map
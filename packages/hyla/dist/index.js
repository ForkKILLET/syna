import { LlmCall, LlmConnector, } from '@syna-demo/llm-contract';
import { Logger } from '@syna-demo/logger';
import { Postgres, PostgresConfig, } from '@syna-demo/postgres';
import { define } from './syna.js';
export const CurrentBlog = define.input('current-blog', {
    metadata: { displayName: 'Current blog' },
});
export const ArticleSummaryLlm = define.binding('article-summary-llm', LlmConnector, {
    metadata: {
        displayName: 'Article summary LLM',
        description: 'The provider selected for article summaries.',
    },
});
export const HylaApplication = define.service('application', {
    requires: {
        database: Postgres,
        logger: Logger,
    },
    setup({ database, logger }) {
        return {
            async status() {
                const db = await database.load();
                const log = await logger.load();
                log.info('Hyla application is ready');
                return {
                    databasePool: db.poolId,
                    databaseUrl: db.connectionString,
                };
            },
        };
    },
});
export const BlogRuntime = define.service('blog-runtime', {
    requires: {
        blog: CurrentBlog,
        database: Postgres,
    },
    setup({ blog, database }) {
        return {
            async describe() {
                const current = await blog.load();
                return `${current.title} (${current.id})`;
            },
            async databasePool() {
                return (await database.load()).poolId;
            },
        };
    },
});
export const ArticleSummarizer = define.service('article-summarizer', {
    requires: {
        blog: CurrentBlog,
        call: LlmCall,
        llm: ArticleSummaryLlm,
    },
    setup({ blog, call, llm }) {
        return {
            async summarize(article) {
                const currentBlog = await blog.load();
                const callContext = await call.load();
                const connector = await llm.load();
                return connector.complete(`Summarize for ${currentBlog.title} (${callContext.requestId}): ${article}`);
            },
            async provider() {
                return (await llm.load()).provider;
            },
        };
    },
});
export const ProviderPanel = define.service('provider-panel', {
    requires: {
        providers: LlmConnector.selector,
    },
    setup({ providers }) {
        return {
            async list() {
                return (await providers.load()).candidates;
            },
            async run(provider, prompt) {
                const selector = await providers.load();
                return selector.run(provider, async (implementation) => {
                    const connector = await implementation.load();
                    return connector.complete(prompt);
                });
            },
        };
    },
});
export const AppEntry = define.entry('app', {
    requires: {
        app: HylaApplication,
    },
    parameters: {
        database: PostgresConfig,
    },
});
export const BlogEntry = define.entry('blog', {
    requires: {
        blog: BlogRuntime,
    },
    parameters: {
        currentBlog: CurrentBlog,
        summaryLlm: ArticleSummaryLlm,
    },
});
export const RequestEntry = define.entry('request', {
    requires: {
        summarizer: ArticleSummarizer,
    },
    parameters: {
        call: LlmCall,
    },
});
export const ProvidersEntry = define.entry('providers', {
    requires: {
        panel: ProviderPanel,
    },
    parameters: {
        call: LlmCall,
    },
});
//# sourceMappingURL=index.js.map
import { LlmCall, LlmConnector } from '@syna-demo/llm-contract';
import { Logger } from '@syna-demo/logger';
import { define } from './syna.js';
export const OpenAI = define.service({
    provides: [LlmConnector],
    requires: {
        call: LlmCall,
        logger: Logger,
    },
    revisionMetadata: {
        displayName: 'OpenAI legacy track',
        description: 'Version 1 compatibility implementation.',
        tags: ['legacy'],
    },
    async setup({ call, logger }) {
        const context = await call.load();
        const log = await logger.load();
        let completions = 0;
        return {
            provider: 'OpenAI',
            implementationVersion: define.package.version,
            generation: 'legacy',
            async complete(prompt) {
                completions += 1;
                log.debug(`OpenAI v1 request ${context.requestId}; completion #${completions}`);
                return `[openai@${define.package.version} request=${context.requestId}] ${prompt}`;
            },
        };
    },
});
//# sourceMappingURL=index.js.map
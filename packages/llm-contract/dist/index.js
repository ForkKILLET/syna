import { define } from './syna.js';
export const LlmConnector = define.contract();
export const LlmCall = define.input('call', {
    metadata: {
        displayName: 'LLM call context',
        description: 'Immutable context attached to one LLM invocation world.',
    },
});
//# sourceMappingURL=index.js.map
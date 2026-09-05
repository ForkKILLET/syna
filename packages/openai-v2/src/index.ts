import { LlmCall, LlmConnector } from '@syna-demo/llm-contract'
import { Logger } from '@syna-demo/logger'
import { define } from './syna.js'

export interface OpenAI extends LlmConnector {
  readonly generation: 'current'
  tokenEstimate(text: string): number
}

export const OpenAI = define.service({
  provides: [LlmConnector],
  requires: {
    call: LlmCall,
    logger: Logger,
  },
  revisionMetadata: {
    displayName: 'OpenAI current track',
    description: 'Recommended version 2 implementation.',
    tags: ['recommended'],
  },
  async setup({ call, logger }): Promise<OpenAI> {
    const context = await call.load()
    const log = await logger.load()
    let completions = 0

    return {
      provider: 'OpenAI',
      implementationVersion: define.package.version,
      generation: 'current',
      tokenEstimate: text => Math.ceil(text.length / 4),
      async complete(prompt) {
        completions += 1
        log.debug(`OpenAI v2 request ${context.requestId}; completion #${completions}`)
        return `[openai@${define.package.version} request=${context.requestId}] ${prompt}`
      },
    }
  },
})

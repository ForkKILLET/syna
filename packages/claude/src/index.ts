import { LlmCall, LlmConnector } from '@syna-demo/llm-contract'
import { Logger } from '@syna-demo/logger'
import { define } from './syna.js'

export interface Claude extends LlmConnector {
  readonly modelFamily: 'claude'
}

export const Claude = define.service({
  provides: [LlmConnector],
  requires: {
    call: LlmCall,
    logger: Logger,
  },
  revisionMetadata: {
    displayName: 'Claude connector',
  },
  async setup({ call, logger }): Promise<Claude> {
    const context = await call.load()
    const log = await logger.load()

    return {
      provider: 'Claude',
      implementationVersion: define.package.version,
      modelFamily: 'claude',
      async complete(prompt) {
        log.debug(`Claude request ${context.requestId}`)
        return `[claude@${define.package.version} request=${context.requestId}] ${prompt}`
      },
    }
  },
})

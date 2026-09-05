import { define } from './syna.js'

export interface LlmConnector {
  readonly provider: string
  readonly implementationVersion: string
  complete(prompt: string): Promise<string>
}

export const LlmConnector = define.contract<LlmConnector>()

export interface LlmCallContext {
  readonly requestId: string
  readonly blogId?: string
}

export const LlmCall = define.input<LlmCallContext>('call', {
  metadata: {
    displayName: 'LLM call context',
    description: 'Immutable context attached to one LLM invocation world.',
  },
})

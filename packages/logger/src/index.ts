import { define } from './syna.js'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  readonly messages: readonly string[]
}

export const Logger = define.service({
  eager: true,
  revisionMetadata: {
    displayName: 'Demo Logger 1.1',
  },
  setup(_dependencies, { onDispose }): Logger {
    const messages: string[] = []
    const write = (level: string, message: string): void => {
      const line = `[${level}] ${message}`
      messages.push(line)
      console.log(line)
    }

    onDispose(() => write('INFO', 'logger disposed'))

    return {
      debug: message => write('DEBUG', message),
      info: message => write('INFO', message),
      get messages() {
        return messages
      },
    }
  },
})

import { define } from './syna.js'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  /** Every line written so far, in order. */
  readonly messages: readonly string[]
  /** True once the sink was closed by the logger's own cleanup. */
  readonly closed: boolean
}

/**
 * Shared infrastructure. Every Service that logs depends on it; none of them
 * closes it: the logger registers its own cleanup and the world that owns the
 * slot runs it, after the Services that depend on it are gone.
 */
export const Logger = define.service({
  eager: true,
  familyMetadata: {
    displayName: 'Logger',
    description: 'One sink per world, opened at activation and closed by its owner.',
  },
  setup(_dependencies, { onDispose }): Logger {
    const messages: string[] = []
    let closed = false
    const write = (level: string, message: string): void => {
      if (closed) throw new Error(`logger: sink already closed (${message})`)
      const line = `[${level}] ${message}`
      messages.push(line)
      console.log(line)
    }

    write('info', 'logger: sink opened')
    onDispose(() => {
      write('info', 'logger: sink closed')
      closed = true
    })

    return {
      debug: message => write('debug', message),
      info: message => write('info', message),
      get messages() {
        return messages
      },
      get closed() {
        return closed
      },
    }
  },
})

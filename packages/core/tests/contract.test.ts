import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Contracts {
    [$ILogger]: ILogger
  }

  export interface Services {
    [$ConsoleLoggerService]: ILogger
    [$Entrypoint]: Entrypoint
  }
}

const $ILogger = Symbol('ILogger')
const $ConsoleLoggerService = Symbol('ConsoleLoggerService')
const $Entrypoint = Symbol('Entrypoint')

interface ILogger {
  type: string
}

interface Entrypoint {
  loggerType: string
}

const ConsoleLoggerService = Service({
  id: $ConsoleLoggerService,
  impl: $ILogger,
  deps: {},
  setup: () => ({
    type: 'console',
  }),
})

const Entrypoint = Service({
  id: $Entrypoint,
  impl: null,
  deps: {
    logger: Dep.Contract($ILogger),
  },
  setup: (ctx) => {
    return {
      loggerType: ctx.logger.type,
    }
  },
})

describe('contracts', () => {
  test('services can implement and depend on contracts', () => {
    const runtime = Runtime()

    runtime.registerContract($ILogger)
    runtime.registerService(ConsoleLoggerService)
    runtime.registerService(Entrypoint)

    const { instance } = runtime.start(Entrypoint)
    expect(instance.loggerType).toBe('console')
  })

  test('throws if no service implements a contract', () => {
    const runtime = Runtime()

    runtime.registerContract($ILogger)
    runtime.registerService(Entrypoint)

    expect(() => runtime.start(Entrypoint)).toThrow()
  })
})
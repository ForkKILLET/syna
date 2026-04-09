import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Contracts {
    [$ILogger]: ILogger
  }

  export interface Services {
    [$EagerService]: EagerService
    [$LazyService]: LazyService
    [$ConsoleLoggerService]: ILogger
    [$Entrypoint]: void
    [$ContractEntrypoint]: void
  }
}

const $EagerService = Symbol('EagerService')
const $LazyService = Symbol('LazyService')
const $ILogger = Symbol('ILogger')
const $ConsoleLoggerService = Symbol('ConsoleLoggerService')
const $Entrypoint = Symbol('Entrypoint')
const $ContractEntrypoint = Symbol('ContractEntrypoint')

interface EagerService {
  kind: 'eager'
}

interface LazyService {
  kind: 'lazy'
}

interface ILogger {
  type: string
}

describe('eager', () => {
  test('eager direct service deps are preloaded before setup, while lazy deps are deferred until access', () => {
    const runtime = Runtime()
    const starts: string[] = []

    const EagerService = Service({
      id: $EagerService,
      impl: null,
      lazy: false,
      deps: {},
      setup: () => {
        starts.push('eager')
        return { kind: 'eager' as const }
      },
    })

    const LazyService = Service({
      id: $LazyService,
      impl: null,
      lazy: true,
      deps: {},
      setup: () => {
        starts.push('lazy')
        return { kind: 'lazy' as const }
      },
    })

    const Entrypoint = Service({
      id: $Entrypoint,
      impl: null,
      deps: {
        eager: Dep.Service($EagerService),
        lazy: Dep.Service($LazyService),
      },
      setup: ctx => {
        expect(starts).toEqual(['eager'])

        expect(ctx.eager.kind).toBe('eager')
        expect(starts).toEqual(['eager'])

        expect(ctx.lazy.kind).toBe('lazy')
        expect(starts).toEqual(['eager', 'lazy'])
      },
    })

    runtime.registerService(EagerService)
    runtime.registerService(LazyService)
    runtime.registerService(Entrypoint)

    runtime.start(Entrypoint)
  })

  test('eager contract implementation is preloaded before setup', () => {
    const runtime = Runtime()
    const starts: string[] = []

    const ConsoleLoggerService = Service({
      id: $ConsoleLoggerService,
      impl: $ILogger,
      lazy: false,
      deps: {},
      setup: () => {
        starts.push('logger')
        return { type: 'console' }
      },
    })

    const ContractEntrypoint = Service({
      id: $ContractEntrypoint,
      impl: null,
      deps: {
        logger: Dep.Contract($ILogger),
      },
      setup: () => {
        expect(starts).toEqual(['logger'])
      },
    })

    runtime.registerContract($ILogger)
    runtime.registerService(ConsoleLoggerService)
    runtime.registerService(ContractEntrypoint)

    runtime.start(ContractEntrypoint)
  })
})

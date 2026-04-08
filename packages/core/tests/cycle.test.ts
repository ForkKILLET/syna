import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Services {
    [$CycleAService]: CycleAService
    [$CycleBService]: CycleBService
    [$Entrypoint]: void
  }
}

const $CycleAService = Symbol('CycleAService')
const $CycleBService = Symbol('CycleBService')
const $Entrypoint = Symbol('CycleRootService')

interface CycleAService {
  b: unknown
}

interface CycleBService {
  a: unknown
}

describe('runtime cycle detection', () => {
  test('throws on circular dependency evaluation', () => {
    const runtime = Runtime()

    const CycleAService = Service({
      id: $CycleAService,
      impl: null,
      deps: {
        b: Dep.Service($CycleBService),
      },
      setup: (ctx) => ({
        b: ctx.b,
      }),
    })

    const CycleBService = Service({
      id: $CycleBService,
      impl: null,
      deps: {
        a: Dep.Service($CycleAService),
      },
      setup: (ctx) => ({
        a: ctx.a,
      }),
    })

    const Entrypoint = Service({
      id: $Entrypoint,
      impl: null,
      deps: {
        a: Dep.Service($CycleAService),
      },
      setup: (ctx) => {
        void ctx.a
      },
    })

    runtime.registerService(CycleAService)
    runtime.registerService(CycleBService)
    runtime.registerService(Entrypoint)

    expect(() => runtime.start(Entrypoint)).toThrow()
  })
})

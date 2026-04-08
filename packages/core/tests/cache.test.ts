import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Services {
    [$SharedService]: SharedService
    [$MiddleService]: MiddleService
    [$Entrypoint]: void
  }
}

const $SharedService = Symbol('AService')

interface SharedService {
  id: number
}

const createSharedService = () => {
  let nextId = 0
  return Service({
    id: $SharedService,
    impl: null,
    deps: {},
    setup: () => {
      return { id: nextId ++ }
    },
  })
}

const $MiddleService = Symbol('MiddleService')

interface MiddleService {
  id: number
}

const MiddleService = Service({
  id: $MiddleService,
  impl: null,
  deps: {
    shared: Dep.Service($SharedService),
  },
  setup: ctx => {
    return { id: ctx.shared.id }
  },
})

const $Entrypoint = Symbol('Entrypoint')

describe('cache', () => {
  test('services are cached by default', () => {
    const runtime = Runtime()

    const Entrypoint = Service({
      id: $Entrypoint,
      impl: null,
      deps: {
        shared1: Dep.Service($SharedService),
        shared2: Dep.Service($SharedService),
        middle: Dep.Service($MiddleService),
      },
      setup: ctx => {
        expect(ctx.shared1.id).toBe(0)
        expect(ctx.shared2.id).toBe(0)
        expect(ctx.middle.id).toBe(0)
      },
    })

    runtime.registerService(createSharedService())
    runtime.registerService(Entrypoint)
  })
})
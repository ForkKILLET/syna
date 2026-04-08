import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Services {
    [$CounterService]: CounterService
    [$Entrypoint]: void
  }
}

const $CounterService = Symbol('CounterService')

interface CounterService {
  getCount(): number
  increment(): void
}

const CounterService = Service({
  id: $CounterService,
  impl: null,
  deps: {},
  setup: () => {
    let count = 0
    return {
      getCount() {
        return count
      },
      increment() {
        count++
      },
    }
  },
})

const $Entrypoint = Symbol('Entrypoint')

describe('isolate', () => {
  test('services can be isolated when deriving sub context', () => {
    const runtime = Runtime()

    runtime.registerService(CounterService)

    const Entrypoint = Service({
      id: $Entrypoint,
      impl: null,
      deps: {
        counter: Dep.Service($CounterService),
      },
      setup: ctx => {
        ctx.counter.increment()
        expect(ctx.counter.getCount()).toBe(1)

        ctx.$derive({ isolate: ['counter'] }, ctx => {
          expect(ctx.counter.getCount()).toBe(0)
          ctx.counter.increment()
          expect(ctx.counter.getCount()).toBe(1)
        })

        expect(ctx.counter.getCount()).toBe(1)
      },
    })

    runtime.registerService(Entrypoint)

    runtime.start(Entrypoint)
  })
})



import { describe, expect, test } from '@rstest/core'
import { Dep, Runtime, Service } from '@syna/core'

declare module '@syna/core' {
  export interface Services {
    [$CounterService]: CounterService
    [$CounterMessageService]: CounterMessageService
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

const $CounterMessageService = Symbol('CounterMessageService')

interface CounterMessageService {
  getMessage(): string
}

const CounterMessageService = Service({
  id: $CounterMessageService,
  impl: null,
  deps: {
    counter: Dep.Service($CounterService),
  },
  setup: ctx => {
    return {
      getMessage() {
        ctx.counter.increment()
        return `Count is ${ctx.counter.getCount()}`
      },
    }
  },
})

const $Entrypoint = Symbol('Entrypoint')

describe('dispose', () => {
  test('services are disposed recursively', () => {
    const runtime = Runtime()

    const Entrypoint = Service({
      id: $Entrypoint,
      impl: null,
      deps: {
        message: Dep.Service($CounterMessageService),
      },
      setup: ctx => {
        expect(ctx.message.getMessage()).toBe('Count is 1')
        ctx.$disposeDep('message') 
        expect(ctx.message.getMessage()).toBe('Count is 1')
      },
    })

    runtime.registerService(CounterService)
    runtime.registerService(CounterMessageService)
    runtime.registerService(Entrypoint)

    runtime.start(Entrypoint)
  })
})


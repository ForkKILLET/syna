import { Dep, Service, Runtime, Context } from '@syna/core'

declare module '@syna/core' {
  export interface Contracts {
    [$IGreeting]: IGreeting
    [$IName]: IName
  }

  export interface Services {
    [$MockNameService]: MockNameService
    [$NoImplService]: NoImplService
    [$SimpleGreetingService]: SimpleGreetingService
    [$EntrypointService]: EntrypointService
    [$CounterService]: CounterService
  }
}

// Contract: IGreeting

export interface IGreeting {
  greet(): void
}

export const $IGreeting = Symbol('IGreeting')

// Contract: IName

export interface IName {
  getName(): string
}
export const $IName = Symbol('IName')

// Service: MockNameService

export const $MockNameService = Symbol('MockNameService')

export interface MockNameService extends IName {}

export const MockNameService = Service({
  id: $MockNameService,
  impl: $IName,
  deps: {},
  setup: () => {
    return {
      getName() {
        return 'Test'
      }
    }
  }
})

// Service: CounterService

export const $CounterService = Symbol('CounterService')

export interface CounterService {
  getCount(): number
  increment(): void
}

export const CounterService = Service({
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
        count ++
      }
    }
  }
})

// Service: NoImplService

export const $NoImplService = Symbol('NoImplService')

export interface NoImplService {
  foo(): string
}

export const NoImplService = Service({
  id: $NoImplService,
  impl: null,
  deps: {},
  setup: () => {
    return {
      foo() {
        return 'This service has no contract implementation.'
      }
    }
  }
})

// Service: SimpleGreeting

export const $SimpleGreetingService = Symbol('SimpleGreeting')

export interface SimpleGreetingService extends IGreeting {}

export const SimpleGreetingService = Service({
  id: $SimpleGreetingService,
  impl: $IGreeting,
  deps: {
    name: Dep.Contract($IName),
    counter: Dep.Service($CounterService),
  },
  setup: ctx => {
    return {
      greet() {
        ctx.counter.increment()
        console.log(`Hello, ${ctx.name.getName()}! (greeted ${ctx.counter.getCount()} times)`)
      }
    }
  }
})

// Service: Entrypoint

export const $EntrypointService = Symbol('EntrypointService')

export type EntrypointService = void

export const EntrypointService = Service({
  id: $EntrypointService,
  impl: null,
  deps: {
    greeting: Dep.Contract($IGreeting),
  },
  setup: ctx => {
    ctx.$on('runtime/service/start', event => console.log(`Service started: ${String(event.serviceId)} as ${String(event.depName)}`))
    ctx.$on('runtime/service/reuse', event => console.log(`Service reused: ${String(event.serviceId)} as ${String(event.depName)}`))

    ctx.greeting.greet()
    ctx.greeting.greet()

    ctx.$derive({ isolate: ['greeting'] }, ctx => {
      ctx.greeting.greet()
    })
  },
})

// App

const app = Runtime()

app.registerContract($IGreeting)
app.registerContract($IName)
app.registerService(SimpleGreetingService)
app.registerService(MockNameService)
app.registerService(CounterService)
app.registerService(EntrypointService)

app.start(EntrypointService)

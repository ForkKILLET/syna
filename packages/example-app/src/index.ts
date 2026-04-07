import { Dependency, Service, Runtime } from '@syna/core'

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
    name: Dependency.Contract($IName),
    mockName: Dependency.Service($MockNameService),
  },
  setup: ctx => {
    return {
      greet() {
        console.log(`Hello, ${ctx.name.getName()}! Hello, ${ctx.mockName.getName()}!`)
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
    greeting: Dependency.Contract($IGreeting),
  },
  setup: ctx => {
    ctx.$on('runtime/service/start', event => console.log(`Service started: ${String(event.serviceId)} as ${String(event.depName)}`))
    ctx.$on('runtime/service/reuse', event => console.log(`Service reused: ${String(event.serviceId)} as ${String(event.depName)}`))
    ctx.$on('runtime/service/derive', event => console.log(`Service derived: ${String(event.serviceId)} as ${String(event.depName)}`))

    ctx.greeting.greet()

    const subCtx = ctx.$derive()
    subCtx.greeting.greet()
  },
})

// App

const app = Runtime()

app.registerContract($IGreeting)
app.registerContract($IName)
app.registerService(SimpleGreetingService)
app.registerService(MockNameService)
app.registerService(EntrypointService)

app.start(EntrypointService)

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
    [$MalformedGreetingService]: MalformedGreetingService
    [$EntrypointService]: EntrypointService
  }
}

// Contract: IGreeting

export interface IGreeting {
  greet(): string
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
        return `Hello, ${ctx.name.getName()}! Hello, ${ctx.mockName.getName()}!`
      }
    }
  }
})


// Service: MalformedGreeting

export const $MalformedGreetingService = Symbol('MalformedGreeting')

export interface MalformedGreetingService /* extends IGreeting */ {
  greet(): /* string */ number
}

export const MalformedGreetingService = Service({
  id: $MalformedGreetingService,
  impl: $IGreeting,
  deps: {
    name: Dependency.Contract($IName),
  },
  // @ts-expect-error
  setup: ctx => {
    return {
      greet() {
        return 42
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
    app.registerContract($IGreeting)
    app.registerContract($IName)
    app.registerService(SimpleGreetingService)
    app.registerService(MockNameService)

    console.log(ctx.greeting.greet())
  },
})

// App

const app = Runtime()

app.registerService(EntrypointService)
app.start(EntrypointService)

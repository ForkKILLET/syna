import { Context, ContextDepName, ContextMeta } from '@/core/context'
import { ContractId } from '@/core/contract'
import { Service, ServiceHandle, ServiceHandleRunning, ServiceId, ServiceState } from '@/core/service'
import { DepMap, DepName, DepType } from '@/core/dependency'
import { unreachable } from '@/utils/error'
import { Emitter } from '@/utils/event'
import { Effect, Services } from '@/index'
import { DefaultMap } from '@/utils/container'

export type DepCache<C extends Context> = {
  [K in keyof C]?: ServiceHandleRunning<C[K], C>
}

export type ServiceCache = Map<ServiceId, ServiceHandle>

export interface ContextEnv<C extends Context = Context> {
  parent: ContextEnv | null
  isolatedDepNames: Set<ContextDepName<C>>
  depCache: DepCache<C>
  serviceCache: ServiceCache
  isolationRootCaches: DefaultMap<ServiceId, ServiceCache>
  effects: Effect[]
}

export type ContextEnvOverride<C extends Context = Context> = Partial<
  Pick<ContextEnv<C>, 'parent' | 'isolatedDepNames' | 'serviceCache'>
>

export const Runtime = () => {
  const contractToImpls = new Map<ContractId, Service[]>()
  const services = new Map<ServiceId, Service>()
  const emitter = Emitter()

  const runtime = {
    registerContract: (contract: ContractId) => {
      if (contractToImpls.has(contract)) {
        throw new Error(`Contract ${String(contract)} is already registered.`)
      }
      contractToImpls.set(contract, [])
    },

    registerService: (service: Service) => {
      if (services.has(service.id)) {
        throw new Error(`Service ${String(service.id)} is already registered.`)
      }
      if (service.impl) {
        const impls = contractToImpls.get(service.impl)
        if (! impls) {
          throw new Error(`Contract ${String(service.impl)} is implemented by service ${String(service.id)} but not registered.`)
        }
        impls.push(service)
      }
      services.set(service.id, service)
    },

    selectImpl: (impls: Service[]): Service => {
      // TODO: configurable impl selection strategy
      return impls[0]
    },

    createContext: <
      SId extends ServiceId = never,
      CId extends ContractId | null = null,
      DM extends DepMap = any,
    >(service: Service<SId, CId, DM>, envOverride: ContextEnvOverride) => {
      type ThisContext = Context<DM>

      const parent = envOverride.parent ?? null
      const env: ContextEnv = {
        parent,
        isolatedDepNames: envOverride.isolatedDepNames ?? new Set(),
        depCache: {},
        serviceCache: envOverride.serviceCache ?? parent?.serviceCache ?? new Map(),
        isolationRootCaches: new DefaultMap(() => new Map()),
        effects: [],
      }

      const isDepIsolated = (depName: DepName): boolean => {
        return env.isolatedDepNames.has(depName)
      }

      const getDepHandle = (depName: DepName, depService: Service, cache: ServiceCache): ServiceHandleRunning => {
        const handle = cache.get(depService.id)
        if (handle?.state === ServiceState.Running) {
          ctx.$emit('runtime/service/reuse', { serviceId: depService.id, depName })
          return handle
        }

        if (handle?.state === ServiceState.Starting) {
          throw new Error(`Circular dependency detected while starting service ${String(depService.id)}.`)
        }
        
        ctx.$emit('runtime/service/start', { serviceId: depService.id, depName })
        return runtime.start(depService, {
          parent: env,
          serviceCache: cache,
        })
      }

      const getDepCache = (depName: DepName, depServiceId: ServiceId) => {
        const isIsolated = isDepIsolated(depName)
        const cache = isIsolated ? env.isolationRootCaches.get(depServiceId) : env.serviceCache
        return { isIsolated, cache }
      }


      const loadDep = (depName: DepName, depService: Service) => {
        const { cache } = getDepCache(depName, depService.id)
        const handle = getDepHandle(depName, depService, cache)
        env.depCache[depName] = handle
        cache.set(depService.id, handle)
        return handle.instance
      }

      const dispose = () => {
        env.effects.forEach(effect => effect())
        env.effects = []

        for (const depName in env.depCache) {
          ctx.$disposeDep(depName)
        }
      }

      const disposeDep = (depName: DepName<DM>) => {
        const handle = env.depCache[depName]
        if (handle?.state !== ServiceState.Running) return

        const { cache } = getDepCache(depName, handle.service.id)

        delete env.depCache[depName]
        cache.delete(handle.service.id)
        
        handle.ctx.$dispose()
      }

      const meta: ContextMeta<DM> = {
        $derive: <T>(...args: Context.DeriveParameters<DM, T>): T => {
          const [{ isolate }, callback] = args.length === 1
            ? [{}, args[0]]
            : args

          const subCtx = runtime.createContext(service, {
            parent: env,
            isolatedDepNames: new Set(isolate),
          })
          return callback(subCtx)
        },
        $dispose: dispose,
        $disposeDep: disposeDep,
        $collect: (effect) => {
          env.effects.push(effect)
        },
        $on: emitter.on,
        $emit: emitter.emit,
      }

      function contextProxyGetTrap(_: ThisContext, prop: symbol): undefined
      function contextProxyGetTrap<M extends keyof ContextMeta>(_: ThisContext, prop: M): ContextMeta<DM>[M]
      function contextProxyGetTrap<K extends DepName<DM>>(_: ThisContext, prop: K): ThisContext[K]
      function contextProxyGetTrap(_: ThisContext, prop: symbol | keyof ContextMeta | DepName<DM>) {
        if (typeof prop === 'symbol') {
          return undefined
        }

        if (prop in meta) {
          return meta[prop as keyof ContextMeta]
        }

        const depName = prop 

        const cachedHandle = env.depCache[depName]
        if (cachedHandle) return cachedHandle.instance

        const dep = service.deps[depName]
        if (! dep) {
          throw new Error(`Dependency ${depName} not declared by service ${String(service.id)}.`)
        }

        if (dep.type === DepType.Service) {
          const service = services.get(dep.serviceId)
          if (! service) {
            throw new Error(`Service ${String(dep.serviceId)} not registered.`)
          }

          return loadDep(depName, service)
        }
        else if (dep.type === DepType.Contract) {
          const impls = contractToImpls.get(dep.contractId)
          if (! impls) {
            throw new Error(`Contract ${String(dep.contractId)} not registered.`)
          }
          if (impls.length === 0) {
            throw new Error(`Contract ${String(dep.contractId)} has no implementations.`)
          }
          const impl = runtime.selectImpl(impls)
          return loadDep(depName, impl)
        }
        else {
          unreachable(dep)
        }
      }
        
      const ctx: ThisContext = new Proxy({} as ThisContext, {
        get: contextProxyGetTrap,
      })

      Object.entries(service.deps).forEach(([depName, dep]) => {
        if (dep.type === DepType.Service) {
          const svc = services.get(dep.serviceId)!
          if (! svc.lazy) void loadDep(depName, svc)
        }
        else if (dep.type === DepType.Contract) {
          contractToImpls.get(dep.contractId)!.forEach(svc => {
            if (! svc.lazy) void loadDep(depName, svc)
          })
        }
        else {
          unreachable(dep)
        }
      })

      ctx.$emit('runtime/context/create', {})

      return ctx
    },

    start: <
      SId extends ServiceId = never,
      CId extends ContractId | null = null,
      DM extends DepMap = any,
    >(
      service: Service<SId, CId, DM>,
      env: ContextEnvOverride<Context<DM>> = {},
    ): ServiceHandleRunning<Services[SId], Context<DM>, SId> => {
      const ctx = runtime.createContext(service, env)
      const instance = service.setup(ctx)
      return {
        state: ServiceState.Running,
        instance,
        service,
        ctx,
      }
    },
  }

  return runtime
}

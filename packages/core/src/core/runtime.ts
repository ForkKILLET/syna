import { Context } from '@/core/context'
import { ContractId } from '@/core/contract'
import { Service, ServiceHandle, ServiceId } from '@/core/service'
import { DependencyMap, DependencyType } from '@/core/dependency'
import { unreachable } from '@/utils/error'

export type ServiceHandleCache<C extends Context> = {
  [K in keyof C]?: ServiceHandle<C[K]>
}

export const Runtime = () => {
  const contracts = new Map<ContractId, Service[]>()
  const impls = new Map<ServiceId, Service>()

  const runtime = {
    registerContract: (contract: ContractId) => {
      if (contracts.has(contract)) {
        throw new Error(`Contract ${String(contract)} is already registered.`)
      }
      contracts.set(contract, [])
    },

    registerService: (service: Service) => {
      if (impls.has(service.id)) {
        throw new Error(`Service ${String(service.id)} is already registered.`)
      }
      if (service.impl) {
        const siblings = contracts.get(service.impl)
        if (! siblings) {
          throw new Error(`Contract ${String(service.impl)} is implemented by service ${String(service.id)} but not registered.`)
        }
        siblings.push(service)
      }
      impls.set(service.id, service)
    },

    chooseImpl: (impls: Service[]): Service => {
      // TODO: configurable impl selection strategy
      return impls[0]
    },

    createContext: <
      SId extends ServiceId = never,
      CId extends ContractId | null = null,
      DM extends DependencyMap = any,
    >(service: Service<SId, CId, DM>) => {
      type ThisContext = Context<DM>

      const cache: ServiceHandleCache<ThisContext> = {}
      const startedServices = new Map<ServiceId, ServiceHandle>()

      const startDep = (depName: keyof DM, service: Service) => {
        console.log(`Starting service ${String(service.id)} as dependency ${String(depName)}...`)
        const handle = runtime.start(service)
        cache[depName] = handle
        startedServices.set(service.id, handle)
        return handle.instance
      }

      const contextProxyHandler: ProxyHandler<ThisContext> = {
        get<K extends keyof DM>(_: ThisContext, prop: K | symbol): ThisContext[K] {
          if (typeof prop === 'symbol') {
            return undefined as any
          }

          const depName = prop

          const cachedHandle = cache[depName]
          if (cachedHandle) return cachedHandle.instance

          const dep = service.deps[depName]
          if (dep.type === DependencyType.Service) {
            const service = impls.get(dep.serviceId)
            if (! service) {
              throw new Error(`Service ${String(dep.serviceId)} not registered.`)
            }

            return startDep(depName, service)
          }
          else if (dep.type === DependencyType.Contract) {
            const impls = contracts.get(dep.contractId)
            if (! impls) {
              throw new Error(`Contract ${String(dep.contractId)} not registered.`)
            }
            if (impls.length === 0) {
              throw new Error(`Contract ${String(dep.contractId)} has no implementations.`)
            }
            const impl = runtime.chooseImpl(impls)
            return startDep(depName, impl)
          }
          else {
            unreachable(dep)
          }
        }
      }

      const ctx: ThisContext = new Proxy({} as ThisContext, contextProxyHandler)

      return ctx
    },

    start: <
      SId extends ServiceId = never,
      CId extends ContractId | null = null,
      DM extends DependencyMap = any,
    >(service: Service<SId, CId, DM>) => {
      const ctx = runtime.createContext(service)
      const instance = service.setup(ctx)
      const handle: ServiceHandle = { instance }
      return handle
    },
  }

  return runtime
}
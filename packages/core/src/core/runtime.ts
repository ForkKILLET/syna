import { Context, ContextMeta } from '@/core/context'
import { ContractId } from '@/core/contract'
import { Service, ServiceHandle, ServiceId } from '@/core/service'
import { DependencyMap, DependencyType } from '@/core/dependency'
import { unreachable } from '@/utils/error'
import { Emitter } from '@/utils/event'

export type ServiceHandleCache<C extends Context> = {
  [K in keyof C]?: ServiceHandle<C[K]>
}

export interface ContextState<C extends Context = Context> {
  parent: ContextState | null
  cache: ServiceHandleCache<C>
  startedServices: Map<ServiceId, ServiceHandle>
}

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
      DM extends DependencyMap = any,
    >(service: Service<SId, CId, DM>, parent: ContextState | null = null) => {
      type ThisContext = Context<DM>

      const state: ContextState = {
        parent,
        cache: {},
        startedServices: new Map(),
      }

      const lookupSharedService = (serviceId: ServiceId): ServiceHandle | null => {
        if (! state.parent) return null
        return state.parent.startedServices.get(serviceId) ?? null
      }

      const getDepHandle = (depName: keyof DM & string, service: Service): ServiceHandle => {
        const startedHandle = state.startedServices.get(service.id)
        if (startedHandle) {
          ctx.$emit('runtime/service/reuse', { serviceId: service.id, depName })
          return startedHandle
        }

        const derivedHandle = lookupSharedService(service.id)
        if (derivedHandle) {
          ctx.$emit('runtime/service/derive', { serviceId: service.id, depName })
          return derivedHandle
        }
        
        ctx.$emit('runtime/service/start', { serviceId: service.id, depName })
        return runtime.start(service)
      }

      const startDep = (depName: keyof DM & string, service: Service) => {
        const handle = getDepHandle(depName, service)
        state.cache[depName] = handle
        state.startedServices.set(service.id, handle)
        return handle.instance
      }

      const derive = () => runtime.createContext(service, state)

      function contextProxyGetTrap(_: ThisContext, prop: symbol): undefined
      function contextProxyGetTrap<M extends keyof ContextMeta>(_: ThisContext, prop: M): ContextMeta<DM>[M]
      function contextProxyGetTrap<K extends keyof DM & string>(_: ThisContext, prop: K): ThisContext[K]
      function contextProxyGetTrap(_: ThisContext, prop: symbol | keyof ContextMeta | keyof DM & string) {
        if (typeof prop === 'symbol') {
          return undefined
        }

        if (prop === '$derive') {
          return derive
        }
        else if (prop === '$on') {
          return emitter.on
        }
        else if (prop === '$emit') {
          return emitter.emit
        }

        const depName = prop 

        const cachedHandle = state.cache[depName]
        if (cachedHandle) return cachedHandle.instance

        const dep = service.deps[depName]
        if (dep.type === DependencyType.Service) {
          const service = services.get(dep.serviceId)
          if (! service) {
            throw new Error(`Service ${String(dep.serviceId)} not registered.`)
          }

          return startDep(depName, service)
        }
        else if (dep.type === DependencyType.Contract) {
          const impls = contractToImpls.get(dep.contractId)
          if (! impls) {
            throw new Error(`Contract ${String(dep.contractId)} not registered.`)
          }
          if (impls.length === 0) {
            throw new Error(`Contract ${String(dep.contractId)} has no implementations.`)
          }
          const impl = runtime.selectImpl(impls)
          return startDep(depName, impl)
        }
        else {
          unreachable(dep)
        }
      }
        
      const ctx: ThisContext = new Proxy({} as ThisContext, {
        get: contextProxyGetTrap,
      })

      ctx.$emit('runtime/context/create', {})

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

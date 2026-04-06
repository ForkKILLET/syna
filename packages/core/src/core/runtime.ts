import { ContractId } from './contract'
import { Service, ServiceId } from './service'

export const Runtime = () => {
  const contracts = new Set<ContractId>()
  const services = new Map<ServiceId, Service>()

  return {
    registerContract: (contract: ContractId) => {
      if (contracts.has(contract)) {
        throw new Error(`Contract ${String(contract)} is already registered.`)
      }
      contracts.add(contract)
    },

    registerService: (service: Service) => {
      if (services.has(service.id)) {
        throw new Error(`Service ${String(service.id)} is already registered.`)
      }
      services.set(service.id, service)
    }
  }
}
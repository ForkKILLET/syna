import { ContractId } from '@/core/contract'
import { ServiceId } from '@/core/service'

export interface ContractDependency<
  CId extends ContractId = ContractId,
> {
  contractId: CId
}

export interface ServiceDependency<
  SId extends ServiceId = ServiceId,
> {
  serviceId: SId
}

export type Dependency = ContractDependency | ServiceDependency

export const ContractDependency = <
  CId extends ContractId,
>(contractId: CId): ContractDependency<CId> => {
  return {
    contractId,
  }
}

export const ServiceDependency = <
  SId extends ServiceId,
>(serviceId: SId): ServiceDependency<SId> => {
  return {
    serviceId,
  }
}

export const Dependency = {
  Contract: ContractDependency,
  Service: ServiceDependency,
}

export type DependencyMap = Record<keyof any, Dependency>
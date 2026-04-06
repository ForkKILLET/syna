import { ContractId } from '@/core/contract'
import { ServiceId } from '@/core/service'

export interface ContractDependency<
  CId extends ContractId = ContractId,
> {
  type: DependencyType.Contract
  contractId: CId
}

export interface ServiceDependency<
  SId extends ServiceId = ServiceId,
> {
  type: DependencyType.Service
  serviceId: SId
}

export type Dependency = ContractDependency | ServiceDependency

export const enum DependencyType {
  Contract,
  Service,
}

export const ContractDependency = <
  CId extends ContractId,
>(contractId: CId): ContractDependency<CId> => {
  return {
    type: DependencyType.Contract,
    contractId,
  }
}

export const ServiceDependency = <
  SId extends ServiceId,
>(serviceId: SId): ServiceDependency<SId> => {
  return {
    type: DependencyType.Service,
    serviceId,
  }
}

export const Dependency = {
  Contract: ContractDependency,
  Service: ServiceDependency,
}

export type DependencyMap = Record<string, Dependency>

export type TopDependencyMap = any
import { ContractId } from '@/core/contract'
import { ServiceId } from '@/core/service'

export interface DependencyBase {
  isolated: boolean
}

export interface ContractDependency<
  CId extends ContractId = ContractId,
> extends DependencyBase {
  type: DependencyType.Contract
  contractId: CId
}

export interface ServiceDependency<
  SId extends ServiceId = ServiceId,
> extends DependencyBase {
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
>(
  contractId: CId,
  { isolated = false }: Partial<Omit<ContractDependency, 'contractId'>> = {},
): ContractDependency<CId> => {
  return {
    type: DependencyType.Contract,
    contractId,
    isolated,
  }
}

export const ServiceDependency = <
  SId extends ServiceId,
>(
  serviceId: SId,
  { isolated = false }: Partial<Omit<ServiceDependency, 'serviceId'>> = {},
): ServiceDependency<SId> => {
  return {
    type: DependencyType.Service,
    serviceId,
    isolated,
  }
}

export const Dependency = {
  Contract: ContractDependency,
  Service: ServiceDependency,
}

export type DependencyMap = Record<string, Dependency>

export type TopDependencyMap = any
import { ContractId } from '@/core/contract'
import { ServiceId } from '@/core/service'

export interface DepBase {
  isolated: boolean
}

export interface ContractDep<
  CId extends ContractId = ContractId,
> extends DepBase {
  type: DepType.Contract
  contractId: CId
}

export interface ServiceDep<
  SId extends ServiceId = ServiceId,
> extends DepBase {
  type: DepType.Service
  serviceId: SId
}

export type Dep = ContractDep | ServiceDep

export const enum DepType {
  Contract,
  Service,
}

export const ContractDep = <
  CId extends ContractId,
>(
  contractId: CId,
  { isolated = false }: Partial<Omit<ContractDep, 'contractId'>> = {},
): ContractDep<CId> => {
  return {
    type: DepType.Contract,
    contractId,
    isolated,
  }
}

export const ServiceDep = <
  SId extends ServiceId,
>(
  serviceId: SId,
  { isolated = false }: Partial<Omit<ServiceDep, 'serviceId'>> = {},
): ServiceDep<SId> => {
  return {
    type: DepType.Service,
    serviceId,
    isolated,
  }
}

export const Dep = {
  Contract: ContractDep,
  Service: ServiceDep,
}

export type DepMap = Record<string, Dep>

export type DepName<DM extends DepMap = TopDepMap> = keyof DM & string

export type TopDepMap = any
import { ContractId, Contracts } from '@/core/contract'
import { DependencyMap, TopDependencyMap } from '@/core/dependency'
import { Context } from '@/core/context'
import { PartialBy, TypedError } from '@/utils/type'

export type ServiceInstance<
  SId extends ServiceId = ServiceId,
  CId extends ContractId | null = ContractId | null,
> =
  CId extends ContractId
    ? Services[SId] extends Contracts[CId]
      ? Services[SId]
      : TypedError<'Service implementation does not satisfy the contract.'>
    : Services[SId]

export interface Service<
  SId extends ServiceId = ServiceId,
  CId extends ContractId | null = ContractId | null,
  DM extends DependencyMap = TopDependencyMap,
> {
  id: SId
  impl: CId
  deps: DM
  lazy: boolean
  setup: ServiceSetup<ServiceInstance<SId, CId>, DM>
}

export interface ServiceSetup<
  T = any,
  DM extends DependencyMap = TopDependencyMap,
> {
  (ctx: Context<DM>): T
}

export const Service = <
  SId extends ServiceId = ServiceId,
  CId extends ContractId | null = ContractId | null,
  DM extends DependencyMap = TopDependencyMap,
>({
  lazy = true,
  ...input
}: PartialBy<Service<SId, CId, DM>, 'lazy'>): Service<SId, CId, DM> => {
  return {
    lazy,
    ...input
  }
}

export interface ServiceHandle<
  T = any,
> {
  instance: T
}

export interface Services {}

export type ServiceId = keyof Services
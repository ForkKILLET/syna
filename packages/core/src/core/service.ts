import { ContractId, Contracts } from '@/core/contract'
import { DependencyMap } from '@/core/dependency'
import { Context } from '@/core/context'
import { TypedError } from '@/utils/type'

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
  DM extends DependencyMap = any,
> {
  id: SId,
  contractId: CId,
  setup: ServiceSetup<ServiceInstance<SId, CId>, DM>,
}

export interface ServiceSetup<T, DM extends DependencyMap = any> {
  (ctx: Context<DM>): T
}

export const Service = <
  SId extends ServiceId = ServiceId,
  CId extends ContractId | null = ContractId | null,
  DM extends DependencyMap = any,
>(input: {
  id: SId,
  impl: CId,
  deps: DM,
  setup: ServiceSetup<ServiceInstance<SId, CId>, DM>,
}): Service<SId, CId, DM> => {
  return {
    id: input.id,
    contractId: input.impl,
    setup: input.setup,
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Services {}

export type ServiceId = keyof Services
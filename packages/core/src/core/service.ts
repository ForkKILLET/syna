import { ContractId, Contracts } from '@/core/contract'
import { DepMap, TopDepMap } from '@/core/dependency'
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
  DM extends DepMap = TopDepMap,
> {
  id: SId
  impl: CId
  deps: DM
  lazy: boolean
  setup: ServiceSetup<ServiceInstance<SId, CId>, DM>
}

export interface ServiceSetup<
  T = any,
  DM extends DepMap = TopDepMap,
> {
  (ctx: Context<DM>): T
}

export const Service = <
  SId extends ServiceId = ServiceId,
  CId extends ContractId | null = ContractId | null,
  DM extends DepMap = TopDepMap,
>({
  lazy = true,
  ...input
}: PartialBy<Service<SId, CId, DM>, 'lazy'>): Service<SId, CId, DM> => {
  return {
    lazy,
    ...input
  }
}

export const enum ServiceState {
  Starting,
  Running,
}

export interface ServiceHandleRunning<
  T = any,
  C extends Context = Context,
  SId extends ServiceId = ServiceId,
> {
  state: ServiceState.Running
  instance: T
  service: Service<SId>
  ctx: C
}

export interface ServiceHandleStarting {
  state: ServiceState.Starting
}

export type ServiceHandle<
  T = any,
  C extends Context = Context,
  SId extends ServiceId = ServiceId,
> = ServiceHandleRunning<T, C, SId> | ServiceHandleStarting

declare const $ExampleService: unique symbol

export interface Services {
  [$ExampleService]: {}
}

export type ServiceId = keyof Services
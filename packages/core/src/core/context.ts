import { ContractDep, DepMap, DepName, ServiceDep, TopDepMap } from '@/core/dependency'
import { ContractId, Contracts } from '@/core/contract'
import { ServiceId, Services } from '@/core/service'
import { Emitter } from '@/utils/event'
import { Effect } from '@/utils/type'

export type ContextBindings<DM extends DepMap> = {
  [K in keyof DM]:
    DM[K] extends ContractDep<infer CID extends ContractId>
      ? Contracts[CID]
      : DM[K] extends ServiceDep<infer SID extends ServiceId>
        ? Services[SID]
        : never
}

export namespace Context {
  export interface DeriveMethod<DM extends DepMap> {
    <T>(callback: (ctx: Context<DM>) => T): T
    <T>(options: DeriveOptions<DM>, callback: (ctx: Context<DM>) => T): T
  }

  export type DeriveParameters<DM extends DepMap, T> =
    | [(ctx: Context<DM>) => T]
    | [DeriveOptions<DM>, (ctx: Context<DM>) => T]

  export interface DeriveOptions<DM extends DepMap> {
    isolate?: DepName<DM>[]
  }
  
  export const expose = <C extends Context>(ctx: C): C => ctx
}

export type ContextMeta<DM extends DepMap = TopDepMap> = {
  $derive: Context.DeriveMethod<DM>

  $dispose: () => void
  $disposeDep: (depName: DepName<DM>) => void
  
  $on: Emitter['on']
  $emit: Emitter['emit']

  $collect: (effect: Effect) => void
}

export type Context<DM extends DepMap = TopDepMap> =
  ContextBindings<DM> & ContextMeta<DM>

export type ContextDepName<C extends Context> =
  C extends Context<infer DM> ? keyof DM : never
  

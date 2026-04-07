import { ContractDependency, DependencyMap, ServiceDependency, TopDependencyMap } from '@/core/dependency'
import { ContractId, Contracts } from '@/core/contract'
import { ServiceId, Services } from '@/core/service'
import { Emitter } from '@/utils/event'

export type ContextBindings<DM extends DependencyMap = TopDependencyMap> = {
  [K in keyof DM]:
    DM[K] extends ContractDependency<infer CID extends ContractId>
      ? Contracts[CID]
      : DM[K] extends ServiceDependency<infer SID extends ServiceId>
        ? Services[SID]
        : never
}

export type ContextMeta<DM extends DependencyMap = TopDependencyMap> = {
  $derive: () => Context<DM>
  $on: Emitter['on']
  $emit: Emitter['emit']
}

export type Context<DM extends DependencyMap = TopDependencyMap> =
  ContextBindings<DM> & ContextMeta<DM>

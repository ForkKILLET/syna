declare const $ExampleContract: unique symbol

export interface Contracts {
  [$ExampleContract]: {}
}

export type ContractId = keyof Contracts

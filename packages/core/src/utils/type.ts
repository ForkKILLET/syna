declare const $TypedError: unique symbol

export type TypedError<S extends string> = {
  [$TypedError]: S
}

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

export type Effect = () => void

export type Func = (...args: any[]) => any

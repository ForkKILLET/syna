declare const $TypedError: unique symbol

export type TypedError<S extends string> = {
  [$TypedError]: S
}
/**
 * `setup()` results are awaited like any Promise-returning function. An
 * instance whose own API has a callable `then` would therefore be mistaken
 * for a thenable. `opaque()` wraps such an instance so the Runtime can unwrap
 * it without ever calling `then`.
 */
export const OPAQUE_INSTANCE: unique symbol = Symbol.for('syna.opaque-instance')

export interface OpaqueInstance<T> {
  readonly [OPAQUE_INSTANCE]: T
}

export function opaque<T>(value: T): OpaqueInstance<T> {
  return Object.freeze({ [OPAQUE_INSTANCE]: value })
}

export function isOpaqueInstance(value: unknown): value is OpaqueInstance<unknown> {
  return typeof value === 'object' && value !== null && OPAQUE_INSTANCE in value
}

export function isForeignThenable(value: unknown): boolean {
  if (value instanceof Promise) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

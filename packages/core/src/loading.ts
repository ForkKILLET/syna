import type { LoadOptions, ServiceRef } from './descriptors.js'

export type LoadedDependencies<Refs extends Readonly<Record<string, ServiceRef<unknown>>>> = {
  readonly [Key in keyof Refs]: Refs[Key] extends ServiceRef<infer Value> ? Value : never
}

/**
 * Load a named group of Service-like dependency refs concurrently. It is an
 * ordinary, catchable batch: one rejection rejects the whole result exactly
 * like `Promise.all`. Input refs are excluded on purpose — read them with
 * `ref.read()` so their payloads are never assimilated.
 */
export async function loadAll<
  const Refs extends Readonly<Record<string, ServiceRef<unknown>>>,
>(refs: Refs, options?: LoadOptions): Promise<LoadedDependencies<Refs>> {
  const entries = await Promise.all(
    Object.entries(refs).map(async ([key, ref]) => [key, await ref.load(options)] as const),
  )
  return Object.freeze(Object.fromEntries(entries)) as LoadedDependencies<Refs>
}

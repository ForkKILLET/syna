import type { DependencyRef } from './descriptors.js';
export type LoadedDependencies<Refs extends Readonly<Record<string, DependencyRef<unknown>>>> = {
    readonly [Key in keyof Refs]: Refs[Key] extends DependencyRef<infer Value> ? Value : never;
};
/**
 * Materialize a named group of dependency references concurrently.
 * The returned object preserves the input keys and inferred value types.
 */
export declare function loadAll<const Refs extends Readonly<Record<string, DependencyRef<unknown>>>>(refs: Refs): Promise<LoadedDependencies<Refs>>;
//# sourceMappingURL=loading.d.ts.map
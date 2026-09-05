import type { AutoImplementation, Contract, ContractApi, Dependency, ForwardDependency, PackageDefinitions, PackageManifest, PersistentImplementationRef, ServiceInstance, ServiceRange, ServiceRevision, ServiceOverride } from './descriptors.js';
export declare function parseImplementationRef<C extends Contract<any>>(contract: C, input: unknown): PersistentImplementationRef<C>;
export declare function auto<C extends Contract<any>>(contract: C): AutoImplementation<C>;
export declare function forward<D extends Dependency>(get: () => D): ForwardDependency<D>;
export declare function override<From extends ServiceRevision<any>, To extends ServiceRevision<any>>(from: From, to: ServiceInstance<To> extends ServiceInstance<From> ? To : never): ServiceOverride<From, To>;
export declare function definePackage(manifest: PackageManifest): PackageDefinitions;
export declare function serviceRange<S extends ServiceRevision<any>>(service: S, range?: string): ServiceRange<S['family']>;
export type { ContractApi, ServiceInstance };
//# sourceMappingURL=definition.d.ts.map
import type { Contract, Dependency, DependencyRef, ServiceRevision } from '../descriptors.js';
export declare function createDependencyRef<T>(load: () => Promise<T>, preload: () => void): DependencyRef<T>;
export declare function isServiceRevision(value: unknown): value is ServiceRevision;
export declare function unwrapDependency(input: Dependency): Exclude<Dependency, {
    kind: 'forward-dependency';
}>;
export declare function providesContract(revision: ServiceRevision, contract: Contract): boolean;
export declare function dependencyIdentity(input: Dependency): string;
export declare function stableJson(value: unknown): string;
/** Structural identity only. Human-facing metadata is intentionally excluded. */
export declare function revisionStructuralSignature(revision: ServiceRevision): string;
export declare function revisionMetadataSignature(revision: ServiceRevision): string;
export declare function assertEquivalentRevisionDefinitions(canonical: ServiceRevision, received: ServiceRevision): string | undefined;
export declare function compareRevisionIdentity(left: ServiceRevision, right: ServiceRevision): number;
/** Prefer an already active exact revision, then the highest compatible version. */
export declare function defaultVersionOrder(candidates: readonly ServiceRevision[], parentActiveRevisionKeys: ReadonlySet<string>): readonly ServiceRevision[];
export declare function distinctImplementationFamilies(candidates: readonly ServiceRevision[]): readonly string[];
//# sourceMappingURL=runtime-utils.d.ts.map
import type { AvailableImplementationCandidate, CandidateRef, Contract, ImplementationCandidate, ImplementationDescriptor, PersistentImplementationRef, RuntimePolicy, ServiceRevision } from '../descriptors.js';
export interface CandidateAvailabilityInput {
    readonly status: 'available' | 'unavailable';
    readonly code?: ImplementationCandidate['availability'] extends infer A ? A extends {
        readonly status: 'unavailable';
        readonly code: infer Code;
    } ? Code : never : never;
    readonly message?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}
export interface CandidateIndexOptions<C extends Contract<any>> {
    readonly contract: C;
    readonly sourceSlotId: string;
    readonly revisions: readonly ServiceRevision[];
    readonly availabilityByRevision?: ReadonlyMap<string, CandidateAvailabilityInput>;
    readonly sitePrefix: string;
    readonly parentActiveRevisionKeys: ReadonlySet<string>;
}
/**
 * Immutable directory over the Runtime's public admission set. It centralizes
 * candidate identity, durable-reference resolution and view-local validation.
 */
export declare class ImplementationDirectory {
    private readonly admittedRevisions;
    private readonly policy;
    private readonly byFamily;
    constructor(admittedRevisions: readonly ServiceRevision[], policy: RuntimePolicy);
    candidatesForImplementationId(implementationId: string): readonly ServiceRevision[];
    candidatesForContract<C extends Contract<any>>(contract: C): readonly ServiceRevision[];
    implementations<C extends Contract<any>>(contract: C): readonly ImplementationDescriptor<C>[];
    resolveCatalog<C extends Contract<any>>(ref: PersistentImplementationRef<C>): ImplementationDescriptor<C>;
    createIndex<C extends Contract<any>>(options: CandidateIndexOptions<C>): CandidateIndex<C>;
    describe<C extends Contract<any>>(contract: Pick<C, 'id'>, revision: ServiceRevision, persistentRef?: PersistentImplementationRef<C>): ImplementationDescriptor<C>;
    resolvePersistentRevision<C extends Contract<any>>(contract: Pick<C, 'id'>, allowed: readonly ServiceRevision[], ref: PersistentImplementationRef<C>, site: string, parentActiveRevisionKeys: ReadonlySet<string>): ServiceRevision;
    validateOrder(original: readonly ServiceRevision[], ordered: readonly ServiceRevision[], site: string): readonly ServiceRevision[];
    private assertPersistentContract;
}
/** One canonical selector/set-local view over exact candidate revisions. */
export declare class CandidateIndex<C extends Contract<any>> {
    private readonly directory;
    private readonly options;
    readonly candidates: readonly ImplementationCandidate<C>[];
    private readonly byRevisionKey;
    constructor(directory: ImplementationDirectory, options: CandidateIndexOptions<C>);
    resolve(ref: PersistentImplementationRef<C>): ImplementationCandidate<C>;
    normalize(input: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>): ImplementationCandidate<C>;
    requireAvailable(input: ImplementationCandidate<C> | CandidateRef<C> | PersistentImplementationRef<C>): AvailableImplementationCandidate<C>;
    revisionKey(candidate: ImplementationCandidate<C>): string;
    private createRef;
}
//# sourceMappingURL=implementation-directory.d.ts.map
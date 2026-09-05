import type { Binding, Contract, EntryDescriptor, EntryParameters, Input, PlannedEnvInspection, RuntimePolicy, ServiceFamily, ServiceRevision } from '../descriptors.js';
import { DefinitionRegistry } from './definition-registry.js';
import { type GraphBuilderHost } from './graph-builder.js';
import { ImplementationDirectory } from './implementation-directory.js';
import { type CacheStats } from './plan-cache.js';
import type { EnvPlanView, ResolvedPlan, ResolutionRealm } from './runtime-model.js';
export declare function entryDefinitionSignature(entry: EntryDescriptor): string;
export interface PlanningParent extends EnvPlanView {
    readonly id: string;
}
export interface PlannedEntry {
    readonly envId: string;
    readonly plan: ResolvedPlan;
    readonly rootSiteByEntryKey: ReadonlyMap<string, string>;
}
/**
 * Compiles immutable Entry declarations into resolved node graphs and
 * canonical logical slots. It deliberately has no authority to materialize a
 * Service or mutate a live Env.
 */
export declare class EntryPlanner implements GraphBuilderHost {
    private readonly definitions;
    private readonly implementationDirectory;
    readonly policy: RuntimePolicy;
    readonly admittedRevisions: readonly ServiceRevision[];
    private readonly planTemplates;
    private nextEnvNumber;
    private nextSlotNumber;
    constructor(definitions: DefinitionRegistry, implementationDirectory: ImplementationDirectory, policy: RuntimePolicy, maxCacheEntries: number);
    cacheStats(): CacheStats;
    clearCache(): void;
    plan<E extends EntryDescriptor<any, any>>(parent: PlanningParent | undefined, descriptor: E, input: EntryParameters<E> | undefined, checking: boolean, realm: ResolutionRealm): PlannedEntry;
    inspect(plan: ResolvedPlan): PlannedEnvInspection;
    activeRevisionKeys(plan?: ResolvedPlan): ReadonlySet<string>;
    canonicalRevision(revision: ServiceRevision, publicOnly: boolean): ServiceRevision;
    entryRealm(owner: ServiceRevision, dependencySite: string, entry: EntryDescriptor): ResolutionRealm;
    registerFamily(family: ServiceFamily): void;
    registerContract(contract: Contract): void;
    registerInput(input: Input): void;
    registerBinding(binding: Binding): void;
    validateCandidateOrder(original: readonly ServiceRevision[], ordered: readonly ServiceRevision[], site: string): readonly ServiceRevision[];
    private planTemplateKey;
    private solvePlanTemplate;
    private assignSlots;
    private validateScopeTargets;
    private mergeScopeTargets;
    private prepareInputs;
    private prepareBindings;
    private resolveBindingAssignment;
    private allocateSlotId;
    private allocateChoiceId;
}
//# sourceMappingURL=entry-planner.d.ts.map
import type { Binding, Contract, Input, RuntimePolicy, EntryDescriptor, ServiceFamily, ServiceRevision } from '../descriptors.js';
import type { BindingChoiceSlot, EnvPlanView, GraphBuildResult, InputSlot, RootSite } from './runtime-model.js';
export interface GraphBuilderHost {
    readonly admittedRevisions: readonly ServiceRevision[];
    readonly policy: RuntimePolicy;
    canonicalRevision(revision: ServiceRevision, publicOnly: boolean): ServiceRevision;
    registerFamily(family: ServiceFamily): void;
    registerContract(contract: Contract): void;
    registerInput(input: Input): void;
    registerBinding(binding: Binding): void;
    entryRealm(owner: ServiceRevision, dependencySite: string, entry: EntryDescriptor): import('./runtime-model.js').ResolutionRealm;
    validateCandidateOrder(original: readonly ServiceRevision[], ordered: readonly ServiceRevision[], site: string): readonly ServiceRevision[];
}
export declare class GraphBuilder {
    private readonly runtime;
    private readonly rootSites;
    private readonly inputSlots;
    private readonly bindingChoices;
    private readonly choices;
    private readonly nodes;
    private readonly rootNodeBySite;
    private readonly parentActiveRevisionKeys;
    constructor(runtime: GraphBuilderHost, rootSites: readonly RootSite[], inputSlots: ReadonlyMap<string, InputSlot>, bindingChoices: ReadonlyMap<string, BindingChoiceSlot>, choices: ReadonlyMap<string, string>, parent?: EnvPlanView);
    build(): GraphBuildResult;
    private resolutionContext;
    private implementationCandidates;
    private resolveDependency;
    private resolveChosenRevision;
    private resolveService;
}
//# sourceMappingURL=graph-builder.d.ts.map
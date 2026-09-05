import type { Binding, Contract, EntryDescriptor, Input, ServiceFamily, ServiceOverride, ServiceRevision } from '../descriptors.js';
import type { ResolutionRealm } from './runtime-model.js';
export interface DefinitionRegistryInspection {
    readonly admittedServices: readonly string[];
    readonly internalServices: readonly string[];
    readonly warnings: readonly string[];
}
/**
 * Compiles the Runtime's immutable definition universe.
 *
 * Public admission and private transitive availability are deliberately kept
 * separate. Definition overrides preserve the source's nominal/public identity
 * while replacing only its implementation manifest.
 */
export declare class DefinitionRegistry {
    private readonly entrySignature;
    readonly admittedRevisions: readonly ServiceRevision[];
    private readonly admittedByKey;
    private readonly internalByKey;
    private readonly effectiveOverrides;
    private readonly familyStructuralSignatures;
    private readonly familyMetadataSignatures;
    private readonly contractMetadataSignatures;
    private readonly inputMetadataSignatures;
    private readonly bindingSignatures;
    private readonly bindingMetadataSignatures;
    private readonly entrySignatures;
    private readonly entryMetadataSignatures;
    private readonly definitionWarnings;
    constructor(services: readonly ServiceRevision[], overrides: readonly ServiceOverride[], entrySignature: (entry: EntryDescriptor) => string);
    inspect(): DefinitionRegistryInspection;
    canonicalRevision(revision: ServiceRevision, publicOnly: boolean): ServiceRevision;
    /** Public implementation candidates only; private helpers never leak. */
    implementationCandidatesForId(implementationId: string): readonly ServiceRevision[];
    entryRealm(owner: ServiceRevision, dependencySite: string, entry: EntryDescriptor): ResolutionRealm;
    effectiveRevisionByKey(key: string): ServiceRevision | undefined;
    effectiveFamilyIds(familyId: string): readonly string[];
    registerFamily(family: ServiceFamily): void;
    registerContract(contract: Contract): void;
    registerInput(input: Input): void;
    registerBinding(binding: Binding): void;
    registerEntry(entry: EntryDescriptor): void;
    private resolveOverride;
    private prepareOverrides;
    private registerAdmittedRevision;
    private collectInternalRevision;
    private collectEntryDefinitions;
    private recordMetadataDrift;
    private recordDefinitionWarning;
    private validateDefinitions;
}
//# sourceMappingURL=definition-registry.d.ts.map
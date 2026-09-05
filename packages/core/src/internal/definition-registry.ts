import type {
  Binding,
  Contract,
  EntryDescriptor,
  Input,
  ServiceFamily,
  ServiceOverride,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { parseVersion } from '../semver.js'
import { privateEntryRealm } from './resolution-realm.js'
import type { ResolutionRealm } from './runtime-model.js'
import {
  assertEquivalentRevisionDefinitions,
  compareRevisionIdentity,
  isServiceRevision,
  stableJson,
  unwrapDependency,
} from './runtime-utils.js'

export interface DefinitionRegistryInspection {
  readonly admittedServices: readonly string[]
  readonly internalServices: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Compiles the Runtime's immutable definition universe.
 *
 * Public admission and private transitive availability are deliberately kept
 * separate. Definition overrides preserve the source's nominal/public identity
 * while replacing only its implementation manifest.
 */
export class DefinitionRegistry {
  readonly admittedRevisions: readonly ServiceRevision[]

  private readonly admittedByKey = new Map<string, ServiceRevision>()
  private readonly internalByKey = new Map<string, ServiceRevision>()
  private readonly effectiveOverrides = new Map<string, ServiceRevision>()
  private readonly familyStructuralSignatures = new Map<string, string>()
  private readonly familyMetadataSignatures = new Map<string, string>()
  private readonly contractMetadataSignatures = new Map<string, string>()
  private readonly inputMetadataSignatures = new Map<string, string>()
  private readonly bindingSignatures = new Map<string, string>()
  private readonly bindingMetadataSignatures = new Map<string, string>()
  private readonly entrySignatures = new Map<string, string>()
  private readonly entryMetadataSignatures = new Map<string, string>()
  private readonly definitionWarnings = new Set<string>()

  constructor(
    services: readonly ServiceRevision[],
    overrides: readonly ServiceOverride[],
    private readonly entrySignature: (entry: EntryDescriptor) => string,
  ) {
    for (const revision of services) this.registerAdmittedRevision(revision)
    for (const revision of this.admittedByKey.values()) this.collectInternalRevision(revision)
    this.prepareOverrides(overrides)
    this.admittedRevisions = Object.freeze(
      [...this.admittedByKey.values()].map(revision => this.resolveOverride(revision)),
    )
    this.validateDefinitions()
  }

  inspect(): DefinitionRegistryInspection {
    return Object.freeze({
      admittedServices: Object.freeze([...this.admittedByKey.keys()].sort()),
      internalServices: Object.freeze([...this.internalByKey.keys()].sort()),
      warnings: Object.freeze([...this.definitionWarnings].sort()),
    })
  }

  canonicalRevision(revision: ServiceRevision, publicOnly: boolean): ServiceRevision {
    const registry = publicOnly ? this.admittedByKey : this.internalByKey
    const canonical = registry.get(revision.key)
    if (!canonical) {
      throw new SynaError(
        'MISSING_SERVICE',
        `${revision.key} is not ${publicOnly ? 'admitted by' : 'known to'} this Runtime.`,
        { revision: revision.key, publicOnly },
      )
    }
    this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(canonical, revision))
    return this.resolveOverride(canonical)
  }

  /** Public implementation candidates only; private helpers never leak. */
  implementationCandidatesForId(implementationId: string): readonly ServiceRevision[] {
    const candidates = new Map<string, ServiceRevision>()
    for (const admitted of this.admittedByKey.values()) {
      if (admitted.family.id !== implementationId) continue
      const effective = this.resolveOverride(admitted)
      candidates.set(effective.key, effective)
    }
    return [...candidates.values()].sort(compareRevisionIdentity)
  }

  entryRealm(
    owner: ServiceRevision,
    dependencySite: string,
    entry: EntryDescriptor,
  ): ResolutionRealm {
    return privateEntryRealm(owner, dependencySite, entry)
  }


  effectiveRevisionByKey(key: string): ServiceRevision | undefined {
    const known = this.internalByKey.get(key)
    return known ? this.resolveOverride(known) : undefined
  }

  effectiveFamilyIds(familyId: string): readonly string[] {
    const result = new Set<string>()
    for (const revision of this.internalByKey.values()) {
      if (revision.family.id === familyId) result.add(this.resolveOverride(revision).family.id)
    }
    return Object.freeze([...result])
  }

  registerFamily(family: ServiceFamily): void {
    const structural = `uniqueWithin=${family.uniqueWithin}`
    const existing = this.familyStructuralSignatures.get(family.id)
    if (existing && existing !== structural) {
      throw new SynaError(
        'DUPLICATE_DEFINITION',
        `Service Family ${family.id} has conflicting structural definitions.`,
        { existing, received: structural },
      )
    }
    this.familyStructuralSignatures.set(family.id, structural)
    this.recordMetadataDrift('Service Family', family.id, family.metadata, this.familyMetadataSignatures)
  }

  registerContract(contract: Contract): void {
    this.recordMetadataDrift('Contract', contract.id, contract.metadata, this.contractMetadataSignatures)
  }

  registerInput(input: Input): void {
    this.recordMetadataDrift('Input', input.id, input.metadata, this.inputMetadataSignatures)
  }

  registerBinding(binding: Binding): void {
    this.registerContract(binding.contract)
    const signature = `${binding.contract.id}|api=${binding.apiVersion}`
    const existing = this.bindingSignatures.get(binding.id)
    if (existing && existing !== signature) {
      throw new SynaError(
        'DUPLICATE_DEFINITION',
        `Binding ${binding.id} has conflicting definitions.`,
        { existing, received: signature },
      )
    }
    this.bindingSignatures.set(binding.id, signature)
    this.recordMetadataDrift('Binding', binding.id, binding.metadata, this.bindingMetadataSignatures)
  }

  registerEntry(entry: EntryDescriptor): void {
    const signature = this.entrySignature(entry)
    const existing = this.entrySignatures.get(entry.id)
    if (existing && existing !== signature) {
      throw new SynaError(
        'DUPLICATE_DEFINITION',
        `Entry ${entry.id} has conflicting definitions.`,
        { existing, received: signature },
      )
    }
    this.entrySignatures.set(entry.id, signature)
    this.recordMetadataDrift('Entry', entry.id, entry.metadata, this.entryMetadataSignatures)
  }

  private resolveOverride(revision: ServiceRevision): ServiceRevision {
    return this.effectiveOverrides.get(revision.key) ?? revision
  }

  private prepareOverrides(overrides: readonly ServiceOverride[]): void {
    // Resolve chains independently of declaration order. A source that is not
    // otherwise reachable may still be the target of another override in the
    // same batch (A -> B, B -> C). Collect all targets before validating any
    // source, but do not admit unrelated sources merely because a descriptor
    // was supplied to override().
    for (const item of overrides) {
      if (item.kind !== 'service-override') {
        throw new SynaError('INVALID_DESCRIPTOR', 'Invalid Runtime service override descriptor.')
      }
      this.collectInternalRevision(item.to)
    }

    const targets = new Map<string, ServiceRevision>()
    for (const item of overrides) {
      const source = this.internalByKey.get(item.from.key)
      if (!source) {
        throw new SynaError(
          'MISSING_SERVICE',
          `Override source ${item.from.key} is not known to this Runtime.`,
        )
      }
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(source, item.from))
      if (targets.has(source.key)) {
        throw new SynaError(
          'DUPLICATE_DEFINITION',
          `Service ${source.key} is overridden more than once.`,
        )
      }
      const target = this.internalByKey.get(item.to.key)!
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(target, item.to))
      targets.set(source.key, target)
    }

    const finalTarget = (sourceKey: string): ServiceRevision => {
      const seen = new Set<string>([sourceKey])
      let target = targets.get(sourceKey)
      if (!target) throw new SynaError('INVALID_DESCRIPTOR', `Missing override target for ${sourceKey}.`)
      while (targets.has(target.key)) {
        if (seen.has(target.key)) {
          throw new SynaError(
            'INVALID_DESCRIPTOR',
            `Runtime service overrides contain a cycle at ${target.key}.`,
          )
        }
        seen.add(target.key)
        target = targets.get(target.key)!
      }
      return target
    }

    for (const sourceKey of targets.keys()) {
      const source = this.internalByKey.get(sourceKey)!
      const target = finalTarget(sourceKey)
      const effective: ServiceRevision = Object.freeze({
        kind: 'service-revision' as const,
        package: source.package,
        family: source.family,
        version: source.version,
        key: source.key,
        requires: target.requires,
        provides: source.provides,
        eager: source.eager,
        failure: target.failure,
        metadata: source.metadata,
        setup: target.setup,
        range: source.range.bind(source),
      })
      this.effectiveOverrides.set(source.key, effective)
    }
  }

  private registerAdmittedRevision(revision: ServiceRevision): void {
    if (!isServiceRevision(revision)) {
      throw new SynaError('INVALID_DESCRIPTOR', 'Runtime services must be ServiceRevision descriptors.')
    }
    parseVersion(revision.version)
    const existing = this.admittedByKey.get(revision.key)
    if (existing) {
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(existing, revision))
      return
    }
    this.admittedByKey.set(revision.key, revision)
    this.registerFamily(revision.family)
  }

  private collectInternalRevision(revision: ServiceRevision): void {
    const existing = this.internalByKey.get(revision.key)
    if (existing) {
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(existing, revision))
      return
    }
    this.internalByKey.set(revision.key, revision)
    this.registerFamily(revision.family)
    for (const contract of revision.provides) this.registerContract(contract)
    for (const dependencyInput of Object.values(revision.requires)) {
      const dependency = unwrapDependency(dependencyInput)
      switch (dependency.kind) {
        case 'service-revision': this.collectInternalRevision(dependency); break
        case 'service-range': this.registerFamily(dependency.family); break
        case 'input': this.registerInput(dependency); break
        case 'binding': this.registerBinding(dependency); break
        case 'entry': this.collectEntryDefinitions(dependency); break
        case 'contract': this.registerContract(dependency); break
        case 'auto-implementation':
        case 'implementation-selector':
        case 'all-implementations': this.registerContract(dependency.contract); break
      }
    }
  }

  private collectEntryDefinitions(entry: EntryDescriptor): void {
    this.registerEntry(entry)
    for (const parameter of Object.values(entry.parameters)) {
      if (parameter.kind === 'input') this.registerInput(parameter)
      else this.registerBinding(parameter)
    }
    for (const dependencyInput of Object.values(entry.requires)) {
      const dependency = unwrapDependency(dependencyInput)
      if (dependency.kind === 'service-revision') this.collectInternalRevision(dependency)
      else if (dependency.kind === 'entry') this.collectEntryDefinitions(dependency)
      else if (dependency.kind === 'input') this.registerInput(dependency)
      else if (dependency.kind === 'binding') this.registerBinding(dependency)
      else if (dependency.kind === 'contract') this.registerContract(dependency)
      else if (
        dependency.kind === 'auto-implementation'
        || dependency.kind === 'implementation-selector'
        || dependency.kind === 'all-implementations'
      ) this.registerContract(dependency.contract)
      else if (dependency.kind === 'service-range') this.registerFamily(dependency.family)
    }
  }

  private recordMetadataDrift(
    kind: string,
    id: string,
    metadata: unknown,
    registry: Map<string, string>,
  ): void {
    const signature = stableJson(metadata)
    const existing = registry.get(id)
    if (existing && existing !== signature) {
      this.definitionWarnings.add(`${kind} ${id} was loaded with different non-semantic metadata.`)
    }
    else registry.set(id, signature)
  }

  private recordDefinitionWarning(warning: string | undefined): void {
    if (warning) this.definitionWarnings.add(warning)
  }

  private validateDefinitions(): void {
    for (const revision of this.internalByKey.values()) {
      for (const contract of revision.provides) {
        if (contract.id.trim().length === 0) {
          throw new SynaError(
            'INVALID_DESCRIPTOR',
            `${revision.key} provides a Contract with an empty id.`,
          )
        }
      }
    }
  }
}

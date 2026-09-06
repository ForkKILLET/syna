import type {
  Binding,
  Contract,
  DefinitionCounts,
  EntryDescriptor,
  Input,
  ServiceFamily,
  ServiceOverride,
  ServiceRevision,
} from '../descriptors.js'
import { SynaError } from '../errors.js'
import { parseVersion } from '../semver.js'
import { privateEntryRealm } from './resolution-realm.js'
import type { CompiledService, ResolutionRealm } from './runtime-model.js'
import {
  assertEquivalentRevisionDefinitions,
  compareRevisionIdentity,
  isServiceRevision,
  stableJson,
  unwrapDependency,
} from './identity.js'

export interface DefinitionInspection {
  readonly admittedServices: readonly string[]
  readonly internalServices: readonly string[]
  readonly overriddenServices: readonly string[]
  readonly warnings: readonly string[]
  readonly definitions: DefinitionCounts
}

/**
 * Compiles the Runtime's immutable definition universe into CompiledService
 * records. Public admission and private transitive availability are kept
 * separate. `override(Source, Fake)` yields one CompiledService with the
 * Source's nominal identity and the Fake's executable manifest.
 *
 * Decision table for overrides:
 *   identity / key / family / version / provides / eager / uniqueWithin / metadata → Source
 *   requires / setup / failure / setupDeadlineMs                                     → Fake
 *   Fake's private dependencies enter the internal closure; Fake is not admitted
 *   unless the deployer admits it separately (then it is its own candidate).
 *   Chains resolve to the final target; duplicate sources and cycles are errors.
 */
export class DefinitionCompiler {
  readonly admitted: readonly CompiledService[]

  private readonly admittedSources = new Map<string, ServiceRevision>()
  private readonly internalSources = new Map<string, ServiceRevision>()
  private readonly compiledByKeyMap = new Map<string, CompiledService>()
  private readonly overrideTargets = new Map<string, ServiceRevision>()
  private readonly closures = new Map<string, ReadonlySet<string>>()
  private readonly realms = new Map<string, ResolutionRealm>()

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
    if (!Array.isArray(services)) {
      throw new SynaError('INVALID_DESCRIPTOR', 'createRuntime() requires a services array.', { descriptor: 'CreateRuntimeOptions.services', problem: 'not-an-array' })
    }
    for (const revision of services) this.registerAdmittedRevision(revision)
    for (const revision of [...this.admittedSources.values()]) this.collectInternalRevision(revision)
    this.prepareOverrides(overrides)
    for (const source of this.internalSources.values()) this.compile(source)
    this.admitted = Object.freeze(
      [...this.admittedSources.keys()]
        .map(key => this.compiledByKeyMap.get(key)!)
        .sort(compareRevisionIdentity),
    )
    this.validateDefinitions()
  }

  inspect(): DefinitionInspection {
    return Object.freeze({
      admittedServices: Object.freeze([...this.admittedSources.keys()].sort()),
      internalServices: Object.freeze([...this.internalSources.keys()].sort()),
      overriddenServices: Object.freeze([...this.overrideTargets.keys()].sort()),
      warnings: Object.freeze([...this.definitionWarnings].sort()),
      definitions: Object.freeze({
        entries: this.entrySignatures.size,
        inputs: this.inputMetadataSignatures.size,
        bindings: this.bindingSignatures.size,
        contracts: this.contractMetadataSignatures.size,
        families: this.familyStructuralSignatures.size,
      }),
    })
  }

  compiledByKey(key: string): CompiledService | undefined {
    return this.compiledByKeyMap.get(key)
  }

  isAdmitted(key: string): boolean {
    return this.admittedSources.has(key)
  }

  /** Every compiled revision of one family known to this Runtime (admitted or private). */
  familyRevisions(familyId: string): readonly CompiledService[] {
    return [...this.compiledByKeyMap.values()]
      .filter(compiled => compiled.family.id === familyId)
      .sort(compareRevisionIdentity)
  }

  /**
   * Resolve a referenced exact descriptor to its compiled record. Throws
   * MISSING_SERVICE when the Runtime does not know it. Structural drift between
   * the reference and the canonical descriptor is a DUPLICATE_DEFINITION error;
   * metadata drift is a warning.
   */
  compiledExact(revision: ServiceRevision): CompiledService {
    const canonical = this.internalSources.get(revision.key)
    if (!canonical) {
      throw new SynaError(
        'MISSING_SERVICE',
        `${revision.key} is not known to this Runtime.`,
        { revision: revision.key },
      )
    }
    this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(canonical, revision))
    return this.compiledByKeyMap.get(revision.key)!
  }

  /** Transitive exact closure reachable from one compiled service through its executable manifest. */
  closureOf(key: string): ReadonlySet<string> {
    const cached = this.closures.get(key)
    if (cached) return cached
    const result = new Set<string>()
    const visitEntry = (entry: EntryDescriptor, seenEntries: Set<string>): void => {
      if (seenEntries.has(entry.id)) return
      seenEntries.add(entry.id)
      for (const dependencyInput of Object.values(entry.requires)) {
        const dependency = unwrapDependency(dependencyInput)
        if (dependency.kind === 'service-revision') visit(dependency.key)
        else if (dependency.kind === 'service-range') visit(dependency.origin.key)
        else if (dependency.kind === 'entry') visitEntry(dependency, seenEntries)
      }
    }
    const visit = (current: string): void => {
      if (result.has(current)) return
      const compiled = this.compiledByKeyMap.get(current)
      if (!compiled) return
      result.add(current)
      for (const dependencyInput of Object.values(compiled.requires)) {
        const dependency = unwrapDependency(dependencyInput)
        // A range's origin is part of the closure like an exact reference: it is
        // the revision the author held when writing the range, so it (and what it
        // requires) is always a candidate the private realm may pick.
        if (dependency.kind === 'service-revision') visit(dependency.key)
        else if (dependency.kind === 'service-range') visit(dependency.origin.key)
        else if (dependency.kind === 'entry') visitEntry(dependency, new Set())
      }
    }
    visit(key)
    const frozen: ReadonlySet<string> = result
    this.closures.set(key, frozen)
    return frozen
  }

  /** Realm under which a Service's own dependencies and its owned Entries resolve. */
  realmFor(owner: CompiledService): ResolutionRealm {
    const cached = this.realms.get(owner.key)
    if (cached) return cached
    const realm = privateEntryRealm(owner.key, this.closureOf(owner.key))
    this.realms.set(owner.key, realm)
    return realm
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
    if (typeof contract !== 'object' || contract === null || contract.kind !== 'contract') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected a Contract descriptor.', { descriptor: 'Contract', problem: 'wrong-kind' })
    }
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
    if (typeof entry !== 'object' || entry === null || entry.kind !== 'entry') {
      throw new SynaError('INVALID_DESCRIPTOR', 'Expected an Entry descriptor.', { descriptor: 'Entry', problem: 'wrong-kind' })
    }
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

  private compile(source: ServiceRevision): CompiledService {
    const existing = this.compiledByKeyMap.get(source.key)
    if (existing) return existing
    const target = this.overrideTargets.get(source.key)
    const executable = target ?? source
    const compiled: CompiledService = Object.freeze({
      key: source.key,
      family: source.family,
      version: source.version,
      source,
      provides: source.provides,
      eager: source.eager,
      requires: executable.requires,
      setup: executable.setup,
      failure: executable.failure,
      setupDeadlineMs: executable.setupDeadlineMs,
      metadata: source.metadata,
      overriddenBy: target,
      admitted: this.admittedSources.has(source.key),
    })
    this.compiledByKeyMap.set(source.key, compiled)
    return compiled
  }

  private prepareOverrides(overrides: readonly ServiceOverride[]): void {
    if (!Array.isArray(overrides)) {
      throw new SynaError('INVALID_DESCRIPTOR', 'createRuntime() overrides must be an array.', { descriptor: 'CreateRuntimeOptions.overrides', problem: 'not-an-array' })
    }
    // Collect every target first so chains (A -> B, B -> C) resolve regardless
    // of declaration order; a source supplied only to override() is not admitted.
    for (const item of overrides) {
      if (typeof item !== 'object' || item === null || item.kind !== 'service-override') {
        throw new SynaError('INVALID_DESCRIPTOR', 'Invalid Runtime service override descriptor.', { descriptor: 'ServiceOverride', problem: 'wrong-kind' })
      }
      if (!isServiceRevision(item.from) || !isServiceRevision(item.to)) {
        throw new SynaError('INVALID_DESCRIPTOR', 'override() expects two ServiceRevision descriptors.', { descriptor: 'ServiceOverride', problem: 'not-service-revisions' })
      }
      if (item.from.key === item.to.key) {
        throw new SynaError(
          'INVALID_DESCRIPTOR',
          `Service ${item.from.key} cannot override itself.`,
          { descriptor: item.from.key, problem: 'self-override' },
        )
      }
      this.collectInternalRevision(item.to)
    }

    const targets = new Map<string, ServiceRevision>()
    for (const item of overrides) {
      const source = this.internalSources.get(item.from.key)
      if (!source) {
        throw new SynaError(
          'MISSING_SERVICE',
          `Override source ${item.from.key} is not known to this Runtime.`,
          { revision: item.from.key },
        )
      }
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(source, item.from))
      if (targets.has(source.key)) {
        throw new SynaError(
          'DUPLICATE_DEFINITION',
          `Service ${source.key} is overridden more than once.`,
          { revision: source.key },
        )
      }
      const target = this.internalSources.get(item.to.key)!
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(target, item.to))
      targets.set(source.key, target)
    }

    const finalTarget = (sourceKey: string): ServiceRevision => {
      const seen = new Set<string>([sourceKey])
      let target = targets.get(sourceKey)!
      while (targets.has(target.key)) {
        if (seen.has(target.key)) {
          throw new SynaError(
            'INVALID_DESCRIPTOR',
            `Runtime service overrides contain a cycle at ${target.key}.`,
            { descriptor: target.key, problem: 'override-cycle', path: [...seen, target.key] },
          )
        }
        seen.add(target.key)
        target = targets.get(target.key)!
      }
      return target
    }

    for (const sourceKey of targets.keys()) {
      this.overrideTargets.set(sourceKey, finalTarget(sourceKey))
    }
  }

  private registerAdmittedRevision(revision: ServiceRevision): void {
    if (!isServiceRevision(revision)) {
      throw new SynaError('INVALID_DESCRIPTOR', 'Runtime services must be ServiceRevision descriptors.', { descriptor: 'ServiceRevision', problem: 'wrong-kind' })
    }
    parseVersion(revision.version)
    const existing = this.admittedSources.get(revision.key)
    if (existing) {
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(existing, revision))
      return
    }
    this.admittedSources.set(revision.key, revision)
    this.registerFamily(revision.family)
  }

  private collectInternalRevision(revision: ServiceRevision): void {
    if (!isServiceRevision(revision)) {
      throw new SynaError('INVALID_DESCRIPTOR', 'A Service dependency must be a ServiceRevision descriptor.', { descriptor: 'ServiceRevision', problem: 'wrong-kind' })
    }
    const existing = this.internalSources.get(revision.key)
    if (existing) {
      this.recordDefinitionWarning(assertEquivalentRevisionDefinitions(existing, revision))
      return
    }
    this.internalSources.set(revision.key, revision)
    this.registerFamily(revision.family)
    for (const contract of revision.provides) this.registerContract(contract)
    this.collectDependencies(Object.values(revision.requires))
  }

  private collectDependencies(dependencies: readonly import('../descriptors.js').Dependency[]): void {
    for (const dependencyInput of dependencies) {
      const dependency = unwrapDependency(dependencyInput)
      switch (dependency.kind) {
        case 'service-revision': this.collectInternalRevision(dependency); break
        case 'service-range':
          this.registerFamily(dependency.family)
          this.collectInternalRevision(dependency.origin)
          break
        case 'input': this.registerInput(dependency); break
        case 'binding': this.registerBinding(dependency); break
        case 'entry': this.collectEntryDefinitions(dependency); break
        case 'contract': this.registerContract(dependency); break
        case 'auto-implementation':
        case 'all-implementations': this.registerContract(dependency.contract); break
        default:
          throw new SynaError(
            'INVALID_DESCRIPTOR',
            `Unknown dependency descriptor kind ${String((dependency as { kind?: unknown }).kind)}.`,
            { descriptor: 'Dependency', problem: 'unknown-kind' },
          )
      }
    }
  }

  private collectEntryDefinitions(entry: EntryDescriptor): void {
    if (this.entrySignatures.has(entry.id)) {
      this.registerEntry(entry)
      return
    }
    this.registerEntry(entry)
    for (const parameter of Object.values(entry.parameters)) {
      if (parameter.kind === 'input') this.registerInput(parameter)
      else this.registerBinding(parameter)
    }
    this.collectDependencies(Object.values(entry.requires))
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
    for (const compiled of this.compiledByKeyMap.values()) {
      for (const contract of compiled.provides) {
        if (typeof contract.id !== 'string' || contract.id.trim().length === 0) {
          throw new SynaError(
            'INVALID_DESCRIPTOR',
            `${compiled.key} provides a Contract with an empty id.`,
            { descriptor: compiled.key, problem: 'empty-contract-id' },
          )
        }
      }
    }
  }
}

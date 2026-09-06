import type {
  AutoImplementation,
  Binding,
  Contract,
  ContractApi,
  DefinitionOptions,
  Dependency,
  DependencyMap,
  DescriptorMetadata,
  EntryDefinition,
  Entry,
  EntryParameter,
  EntryParameterMap,
  ForwardDependency,
  Input,
  MetadataValue,
  NormalizedServiceFailurePolicy,
  PackageDefinitions,
  PackageDescriptor,
  PackageManifest,
  ImplementationRef,
  ProvidedShape,
  ServiceDefinition,
  ServiceFamily,
  ServiceInstance,
  ServiceRevision,
  ServiceOverride,
} from './descriptors.js'
import { SynaError } from './errors.js'
import { assertValidRange, caretRange, isValidRange, normalizeVersion } from './semver.js'

function assertId(id: string, kind: string): void {
  if (id.trim().length === 0) throw new TypeError(`${kind} id must not be empty.`)
}

function assertLocalName(name: string, kind: string): void {
  if (name.trim().length === 0) throw new TypeError(`${kind} name must not be empty.`)
  if (name.includes('@')) throw new TypeError(`${kind} name must not contain "@".`)
}

function assertApiVersion(value: number | undefined): number {
  const version = value ?? 1
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('apiVersion must be a positive safe integer.')
  }
  return version
}

function freezeRecord<T extends Readonly<Record<string, unknown>>>(record: T): T {
  return Object.freeze({ ...record }) as T
}

function freezeMetadataValue(value: MetadataValue): MetadataValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeMetadataValue))
  if (typeof value === 'object' && value !== null) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeMetadataValue(item)]),
    )) as MetadataValue
  }
  return value
}

function freezeMetadata(
  metadata: DescriptorMetadata | undefined,
): Readonly<DescriptorMetadata> {
  if (!metadata) return Object.freeze({})
  return Object.freeze({
    ...(metadata.displayName !== undefined ? { displayName: metadata.displayName } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.tags !== undefined ? { tags: Object.freeze([...metadata.tags]) } : {}),
    ...(metadata.data !== undefined
      ? {
          data: Object.freeze(Object.fromEntries(
            Object.entries(metadata.data).map(([key, value]) => [
              key,
              freezeMetadataValue(value),
            ]),
          )),
        }
      : {}),
  })
}

function mergeMetadata(
  base: Readonly<DescriptorMetadata>,
  override: DescriptorMetadata | undefined,
): Readonly<DescriptorMetadata> {
  if (!override) return base
  const tags = [...new Set([...(base.tags ?? []), ...(override.tags ?? [])])]
  const displayName = override.displayName ?? base.displayName
  const description = override.description ?? base.description
  const data = { ...(base.data ?? {}), ...(override.data ?? {}) }
  return freezeMetadata({
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  })
}

export function createImplementationRef<C extends Contract<any>>(
  contract: Pick<ImplementationRef, 'contractId'> | Pick<Contract, 'id'>,
  familyId: string,
  range: string,
): ImplementationRef<C> {
  assertId(familyId, 'Implementation')
  if (range.trim().length === 0) {
    throw new TypeError('Implementation range must not be empty.')
  }
  assertValidRange(range, `Implementation range for ${familyId}`)
  return Object.freeze({
    kind: 'implementation-ref' as const,
    contractId: 'contractId' in contract ? contract.contractId : contract.id,
    familyId,
    range,
  }) as unknown as ImplementationRef<C>
}

/**
 * The one read path of a serialized implementation reference: a plain object
 * `{ kind: 'implementation-ref', contractId, familyId, range }` naming this
 * Contract, a non-empty family and a valid version range. Anything else — another
 * `kind` (the pre-0.8 kind included), another Contract, a missing or empty family
 * or range, a range that does not parse — is refused with `INVALID_DESCRIPTOR`
 * (`problem`: `not-an-object`, `wrong-kind` or `malformed-implementation-ref`).
 */
export function parseImplementationRef<C extends Contract<any>>(
  contract: C,
  input: unknown,
): ImplementationRef<C> {
  if (typeof input !== 'object' || input === null) {
    throw new SynaError('INVALID_DESCRIPTOR', 'An implementation reference must be an object.', { descriptor: 'ImplementationRef', problem: 'not-an-object' })
  }
  const value = input as Readonly<Record<string, unknown>>
  if (value.kind !== 'implementation-ref') {
    throw new SynaError('INVALID_DESCRIPTOR', `Invalid implementation reference for Contract ${contract.id}: kind must be "implementation-ref".`, { descriptor: 'ImplementationRef', problem: 'wrong-kind' })
  }
  if (
    value.contractId !== contract.id
    || typeof value.familyId !== 'string'
    || value.familyId.trim().length === 0
    || typeof value.range !== 'string'
    || value.range.trim().length === 0
    || !isValidRange(value.range)
  ) {
    throw new SynaError('INVALID_DESCRIPTOR', `Invalid implementation reference for Contract ${contract.id}.`, { descriptor: 'ImplementationRef', problem: 'malformed-implementation-ref' })
  }
  return createImplementationRef(contract, value.familyId, value.range)
}

export function auto<C extends Contract<any>>(contract: C): AutoImplementation<C> {
  return Object.freeze({ kind: 'auto-implementation', contract })
}

export function forward<D extends Dependency>(get: () => D): ForwardDependency<D> {
  return Object.freeze({ kind: 'forward-dependency', get })
}

/**
 * Construction-time definition override. The source keeps its nominal identity,
 * public Contract membership, eagerness and metadata; the replacement supplies
 * the executable `requires`, `setup`, failure policy and deadline. TypeScript
 * checks that the replacement's instance type is assignable to the source's;
 * the Runtime cannot verify behaviour and does not pretend to.
 */
export function override<
  From extends ServiceRevision<any>,
  To extends ServiceRevision<any>,
>(
  from: From,
  to: ServiceInstance<To> extends ServiceInstance<From> ? To : never,
): ServiceOverride<From, To> {
  return Object.freeze({ kind: 'service-override', from, to })
}

function normalizeFailure(
  value: ServiceDefinition<any, any, any>['failure'],
): NormalizedServiceFailurePolicy {
  if (value === undefined || value === 'sticky') {
    return Object.freeze({
      attempts: 1,
      delayMs: 0,
      afterExhaustion: 'sticky' as const,
      cooldownMs: 0,
    })
  }

  const attempts = value.attempts ?? 1
  const delayMs = value.delayMs ?? 0
  const afterExhaustion = value.afterExhaustion ?? 'sticky'
  const cooldownMs = value.cooldownMs ?? 0

  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError('failure.attempts must be a positive integer.')
  }
  for (const [name, amount] of [['failure.delayMs', delayMs], ['failure.cooldownMs', cooldownMs]] as const) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TypeError(`${name} must be a non-negative number.`)
    }
  }
  if (afterExhaustion !== 'sticky' && afterExhaustion !== 'retry-on-next-load') {
    throw new TypeError('failure.afterExhaustion must be "sticky" or "retry-on-next-load".')
  }
  return Object.freeze({ attempts, delayMs, afterExhaustion, cooldownMs })
}

function normalizeDeadline(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (Number.isNaN(value) || value <= 0) {
    throw new TypeError('loadTimeoutMs must be a positive number or Infinity.')
  }
  return value
}

/**
 * Parameter keys reserved for call-time reuse constraints: `reuse` (the options
 * key) and `scope` (its expired 0.5 name, still reserved so a call record can
 * never carry it as a parameter and an old call form is refused, not misread).
 */
const RESERVED_PARAMETER_KEYS: ReadonlySet<string> = new Set(['reuse', 'scope'])

function assertUniqueParameterIds(parameters: EntryParameterMap): void {
  const keyByIdentity = new Map<string, string>()
  for (const [key, descriptor] of Object.entries(parameters)) {
    if (RESERVED_PARAMETER_KEYS.has(key)) {
      throw new TypeError(`Entry parameter name "${key}" is reserved by Syna.`)
    }
    const identity = `${descriptor.kind}:${descriptor.id}`
    const previous = keyByIdentity.get(identity)
    if (previous) {
      throw new TypeError(
        `${descriptor.kind} ${descriptor.id} is declared twice by Entry parameters ${previous} and ${key}.`,
      )
    }
    keyByIdentity.set(identity, key)
  }
}

function assertEntryParameter(value: unknown, key: string): asserts value is EntryParameter {
  if (
    typeof value !== 'object'
    || value === null
    || !['input', 'binding'].includes(String((value as { kind?: unknown }).kind))
  ) {
    throw new TypeError(`Entry parameter ${key} must be an Input or Binding descriptor.`)
  }
}

function normalizePackage(manifest: PackageManifest): PackageDescriptor {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('definePackage() expects a package.json object.')
  }
  if (typeof manifest.name !== 'string') throw new TypeError('package.json name must be a string.')
  if (typeof manifest.version !== 'string') throw new TypeError('package.json version must be a string.')
  assertId(manifest.name, 'Package name')
  const version = normalizeVersion(manifest.version)
  const id = manifest.syna?.id ?? manifest.name
  assertId(id, 'Syna package')
  const metadata = freezeMetadata({
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.syna?.metadata ?? {}),
  })
  return Object.freeze({ name: manifest.name, id, version, metadata })
}

function definitionArguments<T>(
  first: string | T,
  second: T | undefined,
): { readonly name?: string; readonly definition: T } {
  if (typeof first === 'string') {
    assertLocalName(first, 'Definition')
    if (second === undefined) {
      throw new TypeError(`Definition ${first} is missing its descriptor body.`)
    }
    return { name: first, definition: second }
  }
  return { definition: first }
}

function optionsArguments(
  first?: string | DefinitionOptions,
  second?: DefinitionOptions,
): { readonly name?: string; readonly options?: DefinitionOptions } {
  if (typeof first === 'string') {
    assertLocalName(first, 'Definition')
    return second === undefined ? { name: first } : { name: first, options: second }
  }
  return first === undefined ? {} : { options: first }
}

export function definePackage(manifest: PackageManifest): PackageDefinitions {
  const packageDescriptor = normalizePackage(manifest)

  const serviceId = (name?: string): string =>
    name ? `${packageDescriptor.id}/${name}` : packageDescriptor.id
  const contractId = (name: string | undefined, apiVersion: number): string =>
    `${name ? `${packageDescriptor.id}/${name}` : packageDescriptor.id}/v${apiVersion}`
  const inputId = (name: string, apiVersion: number): string =>
    `${packageDescriptor.id}/input/${name}/v${apiVersion}`
  const bindingId = (name: string, apiVersion: number): string =>
    `${packageDescriptor.id}/binding/${name}/v${apiVersion}`
  const entryId = (name: string | undefined, apiVersion: number): string =>
    `${packageDescriptor.id}/entry/${name ?? 'main'}/v${apiVersion}`

  function defineContract<Api>(
    first?: string | DefinitionOptions,
    second?: DefinitionOptions,
  ): Contract<Api> {
    const { name, options } = optionsArguments(first, second)
    const apiVersion = assertApiVersion(options?.apiVersion)
    const mutable = {
      kind: 'contract' as const,
      id: contractId(name, apiVersion),
      apiVersion,
      metadata: mergeMetadata(packageDescriptor.metadata, options?.metadata),
      all: undefined as never,
    }
    const descriptor = mutable as Contract<Api>
    mutable.all = Object.freeze({
      kind: 'all-implementations',
      contract: descriptor,
    }) as never
    return Object.freeze(descriptor)
  }

  function defineInput<T>(name: string, options?: DefinitionOptions): Input<T> {
    assertLocalName(name, 'Input')
    const apiVersion = assertApiVersion(options?.apiVersion)
    return Object.freeze({
      kind: 'input',
      id: inputId(name, apiVersion),
      apiVersion,
      metadata: freezeMetadata(options?.metadata),
    }) as Input<T>
  }

  function defineBinding<C extends Contract<any>>(
    name: string,
    contract: C,
    options?: DefinitionOptions,
  ): Binding<C> {
    assertLocalName(name, 'Binding')
    if (typeof contract !== 'object' || contract === null || contract.kind !== 'contract') {
      throw new TypeError(`Binding ${name} must reference a Contract descriptor.`)
    }
    const apiVersion = assertApiVersion(options?.apiVersion)
    const id = bindingId(name, apiVersion)
    const binding: Binding<C> = {
      kind: 'binding',
      id,
      apiVersion,
      contract,
      metadata: freezeMetadata(options?.metadata),
      to(service, range = caretRange(service.version)) {
        if (!service.provides.some((provided: Contract) => provided.id === contract.id)) {
          throw new TypeError(
            `${service.id} does not explicitly provide Contract ${contract.id}.`,
          )
        }
        return createImplementationRef(
          contract,
          service.family.id,
          range,
        )
      },
      parse(input) {
        return parseImplementationRef(contract, input)
      },
    }
    return Object.freeze(binding)
  }

  function defineService<
    const Requires extends DependencyMap = {},
    const Provides extends readonly Contract[] = readonly [],
    Instance extends ProvidedShape<Provides> = ProvidedShape<Provides>,
  >(
    first: string | ServiceDefinition<Requires, Provides, Instance>,
    second?: ServiceDefinition<Requires, Provides, Instance>,
  ): ServiceRevision<Instance, ProvidedShape<Provides>> {
    type PublicApi = ProvidedShape<Provides>
    const { name, definition } = definitionArguments(first, second)
    if (typeof definition.setup !== 'function') {
      throw new TypeError(`Service ${serviceId(name)} must define a setup function.`)
    }
    if (definition.uniqueWithin !== undefined && definition.uniqueWithin !== 'lineage') {
      throw new TypeError('uniqueWithin must be "lineage" when provided.')
    }
    const family: ServiceFamily<PublicApi> = Object.freeze({
      kind: 'service-family',
      id: serviceId(name),
      ...(definition.uniqueWithin === undefined ? {} : { uniqueWithin: definition.uniqueWithin }),
      metadata: mergeMetadata(packageDescriptor.metadata, definition.familyMetadata),
    })
    const provides = Object.freeze([...(definition.provides ?? [])]) as readonly Contract[]
    const requiredContractIds = Object.freeze(provides.map(contract => contract.id))
    const revision: ServiceRevision<Instance, PublicApi> = Object.freeze({
      kind: 'service-revision' as const,
      package: packageDescriptor,
      family,
      version: packageDescriptor.version,
      id: `${family.id}@${packageDescriptor.version}`,
      requires: freezeRecord((definition.requires ?? {}) as Requires),
      provides,
      eager: definition.eager ?? false,
      failure: normalizeFailure(definition.failure),
      loadTimeoutMs: normalizeDeadline(definition.loadTimeoutMs),
      revisionMetadata: freezeMetadata(definition.revisionMetadata),
      setup: definition.setup as ServiceRevision<Instance, PublicApi>['setup'],
      range(range = '*') {
        assertValidRange(range, `Range for ${family.id}`)
        return Object.freeze({
          kind: 'service-range' as const,
          family,
          range,
          origin: revision,
          requiredContractIds,
        })
      },
    })
    return revision
  }

  function defineEntry<
    const Requires extends DependencyMap = {},
    const Parameters extends EntryParameterMap = {},
  >(
    first: string | EntryDefinition<Requires, Parameters>,
    second?: EntryDefinition<Requires, Parameters>,
  ): Entry<Requires, Parameters> {
    const { name, definition } = definitionArguments(first, second)
    const parameters = freezeRecord((definition.parameters ?? {}) as Parameters)
    for (const [key, descriptor] of Object.entries(parameters)) {
      assertEntryParameter(descriptor, key)
    }
    assertUniqueParameterIds(parameters)
    const apiVersion = assertApiVersion(definition.apiVersion)
    // The expired 0.5 option is refused, never silently ignored (removed in 0.7.0).
    if ((definition as { readonly scope?: unknown }).scope !== undefined) { // syna-v05-compat: refusal of the expired form
      throw new TypeError(`Entry ${entryId(name, apiVersion)} uses the removed option scope; use reuse.`)
    }
    const constraints = definition.reuse

    return Object.freeze({
      kind: 'entry',
      package: packageDescriptor,
      id: entryId(name, apiVersion),
      apiVersion,
      metadata: freezeMetadata(definition.metadata),
      requires: freezeRecord((definition.requires ?? {}) as Requires),
      parameters,
      reuse: Object.freeze({
        fresh: Object.freeze([...(constraints?.fresh ?? [])]),
        share: Object.freeze([...(constraints?.share ?? [])]),
      }),
    })
  }

  return Object.freeze({
    package: packageDescriptor,
    contract: defineContract,
    input: defineInput,
    binding: defineBinding,
    service: defineService,
    entry: defineEntry,
  }) as PackageDefinitions
}

export type { ContractApi, ServiceInstance }

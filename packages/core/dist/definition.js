import { normalizeVersion } from './semver.js';
function assertId(id, kind) {
    if (id.trim().length === 0)
        throw new TypeError(`${kind} id must not be empty.`);
}
function assertLocalName(name, kind) {
    if (name.trim().length === 0)
        throw new TypeError(`${kind} name must not be empty.`);
    if (name.includes('@'))
        throw new TypeError(`${kind} name must not contain "@".`);
}
function assertApiVersion(value) {
    const version = value ?? 1;
    if (!Number.isSafeInteger(version) || version < 1) {
        throw new TypeError('apiVersion must be a positive safe integer.');
    }
    return version;
}
function freezeRecord(record) {
    return Object.freeze({ ...record });
}
function freezeMetadataValue(value) {
    if (Array.isArray(value))
        return Object.freeze(value.map(freezeMetadataValue));
    if (typeof value === 'object' && value !== null) {
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeMetadataValue(item)])));
    }
    return value;
}
function freezeMetadata(metadata) {
    if (!metadata)
        return Object.freeze({});
    return Object.freeze({
        ...(metadata.displayName !== undefined ? { displayName: metadata.displayName } : {}),
        ...(metadata.description !== undefined ? { description: metadata.description } : {}),
        ...(metadata.tags !== undefined ? { tags: Object.freeze([...metadata.tags]) } : {}),
        ...(metadata.data !== undefined
            ? {
                data: Object.freeze(Object.fromEntries(Object.entries(metadata.data).map(([key, value]) => [
                    key,
                    freezeMetadataValue(value),
                ]))),
            }
            : {}),
    });
}
function mergeMetadata(base, override) {
    if (!override)
        return base;
    const tags = [...new Set([...(base.tags ?? []), ...(override.tags ?? [])])];
    const displayName = override.displayName ?? base.displayName;
    const description = override.description ?? base.description;
    const data = { ...(base.data ?? {}), ...(override.data ?? {}) };
    return freezeMetadata({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(Object.keys(data).length > 0 ? { data } : {}),
    });
}
function createPersistentImplementationRef(contract, implementationId, version) {
    assertId(implementationId, 'Implementation');
    if (version.trim().length === 0) {
        throw new TypeError('Implementation version intent must not be empty.');
    }
    return Object.freeze({
        kind: 'persistent-implementation-ref',
        contractId: contract.id,
        implementationId,
        version,
    });
}
export function parseImplementationRef(contract, input) {
    if (typeof input !== 'object' || input === null) {
        throw new TypeError('A persistent implementation reference must be an object.');
    }
    const value = input;
    if (value.kind !== 'persistent-implementation-ref'
        || value.contractId !== contract.id
        || typeof value.implementationId !== 'string'
        || value.implementationId.trim().length === 0
        || typeof value.version !== 'string'
        || value.version.trim().length === 0) {
        throw new TypeError(`Invalid persistent implementation reference for Contract ${contract.id}.`);
    }
    return createPersistentImplementationRef(contract, value.implementationId, value.version);
}
export function auto(contract) {
    return Object.freeze({ kind: 'auto-implementation', contract });
}
export function forward(get) {
    return Object.freeze({ kind: 'forward-dependency', get });
}
export function override(from, to) {
    return Object.freeze({ kind: 'service-override', from, to });
}
function defaultCompatibleRange(version) {
    return `^${normalizeVersion(version)}`;
}
function normalizeFailure(value) {
    if (value === undefined || value === 'sticky') {
        return Object.freeze({
            attempts: 1,
            delayMs: 0,
            afterExhaustion: 'sticky',
            cooldownMs: 0,
        });
    }
    const attempts = value.attempts ?? 1;
    const delayMs = value.delayMs ?? 0;
    const afterExhaustion = value.afterExhaustion ?? 'sticky';
    const cooldownMs = value.cooldownMs ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
        throw new TypeError('failure.attempts must be a positive integer.');
    }
    for (const [name, amount] of [['failure.delayMs', delayMs], ['failure.cooldownMs', cooldownMs]]) {
        if (!Number.isFinite(amount) || amount < 0) {
            throw new TypeError(`${name} must be a non-negative number.`);
        }
    }
    return Object.freeze({ attempts, delayMs, afterExhaustion, cooldownMs });
}
function assertUniqueParameterIds(parameters) {
    const keyByIdentity = new Map();
    for (const [key, descriptor] of Object.entries(parameters)) {
        if (key === 'scope') {
            throw new TypeError('Entry parameter name "scope" is reserved by Syna.');
        }
        const identity = `${descriptor.kind}:${descriptor.id}`;
        const previous = keyByIdentity.get(identity);
        if (previous) {
            throw new TypeError(`${descriptor.kind} ${descriptor.id} is declared twice by Entry parameters ${previous} and ${key}.`);
        }
        keyByIdentity.set(identity, key);
    }
}
function assertEntryParameter(value, key) {
    if (typeof value !== 'object'
        || value === null
        || !['input', 'binding'].includes(String(value.kind))) {
        throw new TypeError(`Entry parameter ${key} must be an Input or Binding descriptor.`);
    }
}
function normalizePackage(manifest) {
    assertId(manifest.name, 'Package name');
    const version = normalizeVersion(manifest.version);
    const id = manifest.syna?.id ?? manifest.name;
    assertId(id, 'Syna package');
    const metadata = freezeMetadata({
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        ...(manifest.syna?.metadata ?? {}),
    });
    return Object.freeze({ name: manifest.name, id, version, metadata });
}
function definitionArguments(first, second) {
    if (typeof first === 'string') {
        assertLocalName(first, 'Definition');
        if (second === undefined) {
            throw new TypeError(`Definition ${first} is missing its descriptor body.`);
        }
        return { name: first, definition: second };
    }
    return { definition: first };
}
function optionsArguments(first, second) {
    if (typeof first === 'string') {
        assertLocalName(first, 'Definition');
        return second === undefined ? { name: first } : { name: first, options: second };
    }
    return first === undefined ? {} : { options: first };
}
export function definePackage(manifest) {
    const packageDescriptor = normalizePackage(manifest);
    const serviceId = (name) => name ? `${packageDescriptor.id}/${name}` : packageDescriptor.id;
    const contractId = (name, apiVersion) => `${name ? `${packageDescriptor.id}/${name}` : packageDescriptor.id}/v${apiVersion}`;
    const inputId = (name, apiVersion) => `${packageDescriptor.id}/input/${name}/v${apiVersion}`;
    const bindingId = (name, apiVersion) => `${packageDescriptor.id}/binding/${name}/v${apiVersion}`;
    const entryId = (name, apiVersion) => `${packageDescriptor.id}/entry/${name ?? 'main'}/v${apiVersion}`;
    function defineContract(first, second) {
        const { name, options } = optionsArguments(first, second);
        const apiVersion = assertApiVersion(options?.apiVersion);
        const mutable = {
            kind: 'contract',
            id: contractId(name, apiVersion),
            apiVersion,
            metadata: mergeMetadata(packageDescriptor.metadata, options?.metadata),
            selector: undefined,
            all: undefined,
        };
        const descriptor = mutable;
        mutable.selector = Object.freeze({
            kind: 'implementation-selector',
            contract: descriptor,
        });
        mutable.all = Object.freeze({
            kind: 'all-implementations',
            contract: descriptor,
        });
        return Object.freeze(descriptor);
    }
    function defineInput(name, options) {
        assertLocalName(name, 'Input');
        const apiVersion = assertApiVersion(options?.apiVersion);
        return Object.freeze({
            kind: 'input',
            id: inputId(name, apiVersion),
            apiVersion,
            metadata: freezeMetadata(options?.metadata),
        });
    }
    function defineBinding(name, contract, options) {
        assertLocalName(name, 'Binding');
        const apiVersion = assertApiVersion(options?.apiVersion);
        const id = bindingId(name, apiVersion);
        const binding = {
            kind: 'binding',
            id,
            apiVersion,
            contract,
            metadata: freezeMetadata(options?.metadata),
            to(service, version = defaultCompatibleRange(service.version)) {
                if (!service.provides.some((provided) => provided.id === contract.id)) {
                    throw new TypeError(`${service.key} does not explicitly provide Contract ${contract.id}.`);
                }
                return createPersistentImplementationRef(contract, service.family.id, version);
            },
            parse(input) {
                return parseImplementationRef(contract, input);
            },
        };
        return Object.freeze(binding);
    }
    function defineService(first, second) {
        const { name, definition } = definitionArguments(first, second);
        const family = Object.freeze({
            kind: 'service-family',
            id: serviceId(name),
            uniqueWithin: definition.uniqueWithin ?? 'none',
            metadata: mergeMetadata(packageDescriptor.metadata, definition.metadata),
        });
        const revision = {
            kind: 'service-revision',
            package: packageDescriptor,
            family,
            version: packageDescriptor.version,
            key: `${family.id}@${packageDescriptor.version}`,
            requires: freezeRecord((definition.requires ?? {})),
            provides: Object.freeze([...(definition.provides ?? [])]),
            eager: definition.eager ?? false,
            failure: normalizeFailure(definition.failure),
            metadata: freezeMetadata(definition.revisionMetadata),
            setup: definition.setup,
            range(version = '*') {
                return Object.freeze({
                    kind: 'service-range',
                    family,
                    range: version,
                });
            },
        };
        return Object.freeze(revision);
    }
    function defineEntry(first, second) {
        const { name, definition } = definitionArguments(first, second);
        const parameters = freezeRecord((definition.parameters ?? {}));
        for (const [key, descriptor] of Object.entries(parameters)) {
            assertEntryParameter(descriptor, key);
        }
        assertUniqueParameterIds(parameters);
        const apiVersion = assertApiVersion(definition.apiVersion);
        return Object.freeze({
            kind: 'entry',
            package: packageDescriptor,
            id: entryId(name, apiVersion),
            apiVersion,
            metadata: freezeMetadata(definition.metadata),
            requires: freezeRecord((definition.requires ?? {})),
            parameters,
            scope: Object.freeze({
                fresh: Object.freeze([...(definition.scope?.fresh ?? [])]),
                share: Object.freeze([...(definition.scope?.share ?? [])]),
            }),
        });
    }
    return Object.freeze({
        package: packageDescriptor,
        contract: defineContract,
        input: defineInput,
        binding: defineBinding,
        service: defineService,
        entry: defineEntry,
    });
}
export function serviceRange(service, range = '*') {
    return service.range(range);
}
//# sourceMappingURL=definition.js.map
import { SynaError } from '../errors.js';
import { normalizeVersion, satisfiesVersion } from '../semver.js';
import { compareRevisionIdentity, providesContract, } from './runtime-utils.js';
/**
 * Immutable directory over the Runtime's public admission set. It centralizes
 * candidate identity, durable-reference resolution and view-local validation.
 */
export class ImplementationDirectory {
    admittedRevisions;
    policy;
    byFamily = new Map();
    constructor(admittedRevisions, policy) {
        this.admittedRevisions = admittedRevisions;
        this.policy = policy;
        const mutable = new Map();
        for (const revision of admittedRevisions) {
            const list = mutable.get(revision.family.id) ?? [];
            list.push(revision);
            mutable.set(revision.family.id, list);
        }
        for (const [familyId, revisions] of mutable) {
            this.byFamily.set(familyId, Object.freeze([...revisions].sort(compareRevisionIdentity)));
        }
    }
    candidatesForImplementationId(implementationId) {
        return this.byFamily.get(implementationId) ?? Object.freeze([]);
    }
    candidatesForContract(contract) {
        return Object.freeze(this.admittedRevisions
            .filter(revision => providesContract(revision, contract))
            .sort(compareRevisionIdentity));
    }
    implementations(contract) {
        return Object.freeze(this.candidatesForContract(contract)
            .map(revision => this.describe(contract, revision)));
    }
    resolveCatalog(ref) {
        const contract = { id: ref.contractId };
        const revision = this.resolvePersistentRevision(contract, this.admittedRevisions.filter(candidate => providesContract(candidate, contract)), ref, `catalog:${ref.contractId}:${ref.implementationId}`, new Set());
        return this.describe(contract, revision, ref);
    }
    createIndex(options) {
        return new CandidateIndex(this, options);
    }
    describe(contract, revision, persistentRef) {
        return Object.freeze({
            contractId: contract.id,
            familyId: revision.family.id,
            version: revision.version,
            eager: revision.eager,
            familyMetadata: revision.family.metadata,
            revisionMetadata: revision.metadata,
            persistentRef: persistentRef ?? Object.freeze({
                kind: 'persistent-implementation-ref',
                contractId: contract.id,
                implementationId: revision.family.id,
                version: `^${normalizeVersion(revision.version)}`,
            }),
        });
    }
    resolvePersistentRevision(contract, allowed, ref, site, parentActiveRevisionKeys) {
        this.assertPersistentContract(contract, ref);
        const allowedKeys = new Set(allowed.map(candidate => candidate.key));
        const matching = this.candidatesForImplementationId(ref.implementationId)
            .filter(candidate => allowedKeys.has(candidate.key))
            .filter(candidate => providesContract(candidate, contract))
            .filter(candidate => satisfiesVersion(candidate.version, ref.version));
        if (matching.length === 0) {
            throw new SynaError('MISSING_IMPLEMENTATION', `No ${ref.implementationId} candidate for ${contract.id} satisfies ${ref.version}.`, {
                contract: contract.id,
                implementation: ref.implementationId,
                version: ref.version,
            });
        }
        const ordered = this.validateOrder(matching, this.policy.orderVersionCandidates(matching[0].family, matching, { site, parentActiveRevisionKeys }), site);
        return ordered[0];
    }
    validateOrder(original, ordered, site) {
        const originalKeys = [...original].map(candidate => candidate.key).sort();
        const orderedKeys = [...ordered].map(candidate => candidate.key).sort();
        if (originalKeys.length !== orderedKeys.length
            || originalKeys.some((key, index) => key !== orderedKeys[index])) {
            throw new SynaError('INVALID_DESCRIPTOR', `Resolution policy must return every candidate exactly once at ${site}.`, { site, original: originalKeys, ordered: orderedKeys });
        }
        return ordered;
    }
    assertPersistentContract(contract, ref) {
        if (ref.contractId !== contract.id) {
            throw new SynaError('INCOMPATIBLE_IMPLEMENTATION', `Implementation reference for ${ref.contractId} cannot be used with ${contract.id}.`);
        }
    }
}
/** One canonical selector/set-local view over exact candidate revisions. */
export class CandidateIndex {
    directory;
    options;
    candidates;
    byRevisionKey = new Map();
    constructor(directory, options) {
        this.directory = directory;
        this.options = options;
        const values = [];
        for (const revision of options.revisions) {
            const availability = options.availabilityByRevision?.get(revision.key);
            const normalizedAvailability = availability?.status === 'unavailable'
                ? Object.freeze({
                    status: 'unavailable',
                    code: availability.code ?? 'UNKNOWN_ERROR',
                    message: availability.message ?? 'Implementation is unavailable.',
                    details: availability.details ?? Object.freeze({}),
                })
                : Object.freeze({ status: 'available' });
            const candidate = Object.freeze({
                ...directory.describe(options.contract, revision),
                ref: this.createRef(revision),
                availability: normalizedAvailability,
            });
            values.push(candidate);
            this.byRevisionKey.set(revision.key, candidate);
        }
        this.candidates = Object.freeze(values);
    }
    resolve(ref) {
        const selected = this.directory.resolvePersistentRevision(this.options.contract, this.options.revisions, ref, `${this.options.sitePrefix}/persistent:${ref.implementationId}`, this.options.parentActiveRevisionKeys);
        return this.byRevisionKey.get(selected.key);
    }
    normalize(input) {
        if ('kind' in input && input.kind === 'persistent-implementation-ref') {
            return this.resolve(input);
        }
        const ref = ('ref' in input ? input.ref : input);
        if (ref.sourceSlotId !== this.options.sourceSlotId) {
            throw new SynaError('CONSTRAINT_VIOLATION', 'CandidateRef belongs to another implementation view.', {
                expectedSourceSlot: this.options.sourceSlotId,
                receivedSourceSlot: ref.sourceSlotId,
            });
        }
        const candidate = this.byRevisionKey.get(ref.revisionKey);
        if (!candidate) {
            throw new SynaError('MISSING_IMPLEMENTATION', 'Candidate does not belong to this implementation view.');
        }
        return candidate;
    }
    requireAvailable(input) {
        const candidate = this.normalize(input);
        if (candidate.availability.status === 'unavailable') {
            throw new SynaError('UNAVAILABLE_IMPLEMENTATION', `${candidate.familyId}@${candidate.version} is unavailable: ${candidate.availability.message}`, {
                candidate: `${candidate.familyId}@${candidate.version}`,
                reason: candidate.availability,
            });
        }
        return candidate;
    }
    revisionKey(candidate) {
        return candidate.ref.revisionKey;
    }
    createRef(revision) {
        return Object.freeze({
            kind: 'candidate-ref',
            contract: this.options.contract,
            familyId: revision.family.id,
            version: revision.version,
            sourceSlotId: this.options.sourceSlotId,
            revisionKey: revision.key,
        });
    }
}
//# sourceMappingURL=implementation-directory.js.map
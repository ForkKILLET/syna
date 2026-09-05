import packageJson from '../package.json' with { type: 'json' };
import { asSynaError, diagnosticFromError, SynaError } from './errors.js';
import { defaultVersionOrder } from './internal/runtime-utils.js';
import { PUBLIC_REALM } from './internal/resolution-realm.js';
import { Materializer } from './internal/materializer.js';
import { DefinitionRegistry } from './internal/definition-registry.js';
import { ImplementationDirectory, } from './internal/implementation-directory.js';
import { EntryPlanner, entryDefinitionSignature, } from './internal/entry-planner.js';
import { isBacktrackableTopologyError } from './internal/solve-errors.js';
const internalPackage = Object.freeze({
    name: '@syna/core',
    id: '@syna/core',
    version: packageJson.version,
    metadata: Object.freeze({}),
});
const internalDeriveEntry = Object.freeze({
    kind: 'entry',
    package: internalPackage,
    id: '@syna/core/entry/derive/v1',
    apiVersion: 1,
    requires: Object.freeze({}),
    parameters: Object.freeze({}),
    scope: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
    metadata: Object.freeze({}),
});
function addSuppressed(primary, cleanup) {
    if (primary instanceof Error && Object.isExtensible(primary)) {
        Object.defineProperty(primary, 'suppressed', {
            configurable: true,
            enumerable: false,
            value: cleanup,
        });
        return primary;
    }
    return new AggregateError([primary, cleanup], 'Entry execution and Env disposal both failed.', primary instanceof Error ? { cause: primary } : undefined);
}
export const defaultRuntimePolicy = Object.freeze({
    orderAutoCandidates(contract, candidates, context) {
        const families = new Set(candidates.map(candidate => candidate.family.id));
        if (families.size > 1) {
            throw new SynaError('MISSING_AUTO_POLICY', `auto(${contract.id}) has multiple implementation families, but this Runtime has no explicit auto-selection policy.`, { contract: contract.id, site: context.site, families: [...families].sort() });
        }
        return defaultVersionOrder(candidates, context.parentActiveRevisionKeys);
    },
    orderVersionCandidates(_family, candidates, context) {
        return defaultVersionOrder(candidates, context.parentActiveRevisionKeys);
    },
});
class EnvImpl {
    runtime;
    id;
    parent;
    plan;
    children = new Set();
    deps;
    abortController = new AbortController();
    state = 'activating';
    disposePromise;
    constructor(runtime, id, parent, plan, rootSiteByEntryKey) {
        this.runtime = runtime;
        this.id = id;
        this.parent = parent;
        this.plan = plan;
        const refs = {};
        for (const [key, rootSiteId] of rootSiteByEntryKey) {
            const nodeId = plan.rootNodeBySite.get(rootSiteId);
            const slot = plan.slotsByNode.get(nodeId);
            refs[key] = runtime.createDependencyRef(slot);
        }
        this.deps = Object.freeze(refs);
    }
    enter(descriptor, ...args) {
        return this.runtime.enterFrom(this, descriptor, args[0], PUBLIC_REALM);
    }
    async run(descriptor, ...args) {
        const [input, callback] = args.length === 1
            ? [{}, args[0]]
            : args;
        const child = await this.runtime.enterFrom(this, descriptor, input, PUBLIC_REALM);
        return this.runtime.executeStructured(child, () => callback(child.deps, child));
    }
    check(descriptor, ...args) {
        return this.runtime.checkFrom(this, descriptor, args[0], PUBLIC_REALM);
    }
    derive(options = {}) {
        return this.runtime.enterFrom(this, internalDeriveEntry, { scope: options }, PUBLIC_REALM);
    }
    bind(descriptor) {
        return this.runtime.createBoundEntry(descriptor, this, PUBLIC_REALM, false);
    }
    inspect() {
        const nodes = [...this.plan.nodes.values()]
            .map(node => {
            const slot = this.plan.slotsByNode.get(node.id);
            return {
                nodeId: node.id,
                kind: node.kind,
                label: node.label,
                slotId: slot.id,
                ownerEnvId: slot.ownerEnvId,
                state: slot.state,
                dependencies: Object.fromEntries([...slot.requires.entries()].map(([key, dependency]) => [key, dependency.id])),
            };
        })
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
        return {
            id: this.id,
            ...(this.parent ? { parentId: this.parent.id } : {}),
            state: this.state,
            nodes,
        };
    }
    dispose() {
        this.disposePromise ??= this.runtime.disposeEnv(this);
        return this.disposePromise;
    }
    [Symbol.asyncDispose]() {
        return this.dispose();
    }
}
class RuntimeImpl {
    admittedRevisions;
    policy;
    catalog;
    roots = new Set();
    definitions;
    materializer = new Materializer();
    implementationDirectory;
    envById = new Map();
    planner;
    disposed = false;
    disposePromise;
    constructor(options) {
        const policy = options.policy ?? {};
        this.policy = Object.freeze({
            orderAutoCandidates: policy.orderAutoCandidates ?? defaultRuntimePolicy.orderAutoCandidates,
            orderVersionCandidates: policy.orderVersionCandidates ?? defaultRuntimePolicy.orderVersionCandidates,
        });
        this.definitions = new DefinitionRegistry(options.services, options.overrides ?? [], entryDefinitionSignature);
        this.admittedRevisions = this.definitions.admittedRevisions;
        this.implementationDirectory = new ImplementationDirectory(this.admittedRevisions, this.policy);
        this.planner = new EntryPlanner(this.definitions, this.implementationDirectory, this.policy, options.planCache?.maxEntries ?? 512);
        this.catalog = Object.freeze({
            implementations: (contract) => this.implementationDirectory.implementations(contract),
            resolve: (ref) => this.implementationDirectory.resolveCatalog(ref),
        });
    }
    inspect() {
        const planCache = this.planner.cacheStats();
        const definitions = this.definitions.inspect();
        return {
            admittedServices: definitions.admittedServices,
            internalServices: definitions.internalServices,
            rootEnvCount: [...this.roots].filter(root => root.state !== 'disposed').length,
            planCache,
            definitionWarnings: definitions.warnings,
        };
    }
    enter(descriptor, ...args) {
        return this.enterFrom(undefined, descriptor, args[0], PUBLIC_REALM);
    }
    async run(descriptor, ...args) {
        const [input, callback] = args.length === 1
            ? [{}, args[0]]
            : args;
        const env = await this.enterFrom(undefined, descriptor, input, PUBLIC_REALM);
        return this.executeStructured(env, () => callback(env.deps, env));
    }
    check(descriptor, ...args) {
        return this.checkFrom(undefined, descriptor, args[0], PUBLIC_REALM);
    }
    dispose() {
        this.disposePromise ??= (async () => {
            if (this.disposed)
                return;
            this.disposed = true;
            const errors = [];
            for (const root of [...this.roots]) {
                try {
                    await root.dispose();
                }
                catch (error) {
                    errors.push(error);
                }
            }
            this.planner.clearCache();
            if (errors.length > 0) {
                throw new AggregateError(errors, 'One or more Syna root Envs failed to dispose.');
            }
        })();
        return this.disposePromise;
    }
    [Symbol.asyncDispose]() {
        return this.dispose();
    }
    async executeStructured(env, callback) {
        let result;
        try {
            result = await callback();
        }
        catch (primary) {
            try {
                await env.dispose();
            }
            catch (cleanup) {
                throw addSuppressed(primary, cleanup);
            }
            throw primary;
        }
        await env.dispose();
        return result;
    }
    createBoundEntry(descriptor, anchor, realm, allowActivatingAnchor) {
        const enterBound = (...args) => {
            const frame = this.materializer.activeFrame();
            const operation = this.enterFrom(anchor, descriptor, args[0], realm, allowActivatingAnchor, frame?.slot);
            return this.materializer.trackStrongOperation(operation, frame);
        };
        const runBound = (...args) => {
            const frame = this.materializer.activeFrame();
            const [input, callback] = args.length === 1
                ? [{}, args[0]]
                : args;
            const operation = (async () => {
                const child = await this.enterFrom(anchor, descriptor, input, realm, allowActivatingAnchor, frame?.slot);
                return this.executeStructured(child, () => callback(child.deps, child));
            })();
            return this.materializer.trackStrongOperation(operation, frame);
        };
        return Object.freeze({
            enter: enterBound,
            run: runBound,
            check: (...args) => this.checkFrom(anchor, descriptor, args[0], realm, allowActivatingAnchor),
        });
    }
    async checkFrom(parent, descriptor, input, realm = PUBLIC_REALM, allowActivatingParent = false, rethrowUnexpected = false) {
        try {
            const { plan } = this.planEntry(parent, descriptor, input, true, allowActivatingParent, realm);
            return Object.freeze({ ok: true, inspection: this.planner.inspect(plan) });
        }
        catch (error) {
            if (rethrowUnexpected && !isBacktrackableTopologyError(error))
                throw error;
            return Object.freeze({ ok: false, error: diagnosticFromError(error) });
        }
    }
    async enterFrom(parent, descriptor, input, realm = PUBLIC_REALM, allowActivatingParent = false, activationRequester) {
        const { envId, plan, rootSiteByEntryKey } = this.planEntry(parent, descriptor, input, false, allowActivatingParent, realm);
        const env = new EnvImpl(this, envId, parent, plan, rootSiteByEntryKey);
        this.envById.set(env.id, env);
        for (const slot of new Set(plan.slotsByNode.values())) {
            if (slot.kind === 'service' && slot.ownerEnvId === envId)
                slot.ownerEnv = env;
        }
        if (parent)
            parent.children.add(env);
        else
            this.roots.add(env);
        const activationTaskId = `activation:${env.id}`;
        if (activationRequester) {
            this.materializer.addWaitEdge(activationRequester.id, activationTaskId, activationRequester.revision.key, `Entry ${descriptor.id}`);
        }
        try {
            await this.prepareSyntheticValues(env);
            await this.activateEnv(env, activationTaskId);
            if (env.state !== 'activating') {
                throw new SynaError('INVALID_ENV_STATE', `Env ${env.id} was closed before activation completed.`, { env: env.id, state: env.state });
            }
            env.state = 'ready';
            return env;
        }
        catch (error) {
            try {
                await env.dispose();
            }
            catch (cleanup) {
                throw addSuppressed(error, cleanup);
            }
            throw asSynaError(error, 'ENTRY_ACTIVATION_FAILED', `Entry ${descriptor.id} failed while activating Env ${envId}.`, { entry: descriptor.id, env: envId });
        }
        finally {
            if (activationRequester) {
                this.materializer.removeWaitEdge(activationRequester.id, activationTaskId);
            }
        }
    }
    planEntry(parent, descriptor, parameters, checking, allowActivatingParent, realm) {
        this.assertEntryUsable(parent, descriptor, allowActivatingParent);
        return this.planner.plan(parent, descriptor, parameters, checking, realm);
    }
    assertEntryUsable(parent, descriptor, allowActivatingParent) {
        if (this.disposed)
            throw new SynaError('INVALID_ENV_STATE', 'The Syna Runtime is disposed.');
        if (parent && parent.runtime !== this) {
            throw new SynaError('RUNTIME_MISMATCH', 'An Entry anchor belongs to another Runtime.');
        }
        if (parent && parent.state !== 'ready' && !(allowActivatingParent && parent.state === 'activating')) {
            throw new SynaError('INVALID_ENV_STATE', `Cannot enter from Env ${parent.id} while it is ${parent.state}.`);
        }
        if (descriptor.kind !== 'entry') {
            throw new SynaError('INVALID_DESCRIPTOR', 'Expected an Entry descriptor.');
        }
    }
    createDependencyRef(slot) {
        return this.materializer.createRef(slot);
    }
    async prepareSyntheticValues(env) {
        for (const node of env.plan.nodes.values()) {
            const slot = env.plan.slotsByNode.get(node.id);
            if (slot.ownerEnvId !== env.id || slot.kind === 'service' || slot.kind === 'input' || slot.value !== undefined) {
                continue;
            }
            if (node.kind === 'selector')
                slot.value = await this.createSelector(node, slot, env);
            else if (node.kind === 'all')
                slot.value = this.createImplementationSet(node, slot, env);
            else if (node.kind === 'entry') {
                const anchor = this.anchorForSyntheticNode(node.anchorNodeId, env.plan, env);
                slot.value = this.createBoundEntry(node.entry, anchor, node.realm, true);
            }
            Object.freeze(slot.requires);
        }
    }
    anchorForSyntheticNode(anchorNodeId, plan, fallback) {
        if (!anchorNodeId)
            return fallback;
        const anchorSlot = plan.slotsByNode.get(anchorNodeId);
        if (!anchorSlot)
            throw new SynaError('INVALID_ENV_STATE', `Missing anchor node ${anchorNodeId}.`);
        const anchor = this.envById.get(anchorSlot.ownerEnvId);
        if (!anchor)
            throw new SynaError('INVALID_ENV_STATE', `Missing anchor Env ${anchorSlot.ownerEnvId}.`);
        return anchor;
    }
    async createSelector(node, slot, env) {
        const anchor = this.anchorForSyntheticNode(node.anchorNodeId, env.plan, env);
        const availabilityByRevision = new Map();
        const boundEntryByRevision = new Map();
        for (const revision of node.candidates) {
            const entry = this.candidateEntry(node.contract, revision);
            const check = await this.checkFrom(anchor, entry, {}, PUBLIC_REALM, true, true);
            boundEntryByRevision.set(revision.key, this.createBoundEntry(entry, anchor, PUBLIC_REALM, true));
            availabilityByRevision.set(revision.key, check.ok
                ? Object.freeze({ status: 'available' })
                : Object.freeze({
                    status: 'unavailable',
                    code: check.error.code,
                    message: check.error.message,
                    details: check.error.details,
                }));
        }
        const index = this.implementationDirectory.createIndex({
            contract: node.contract,
            sourceSlotId: slot.id,
            revisions: node.candidates,
            availabilityByRevision,
            sitePrefix: node.dependencySite,
            parentActiveRevisionKeys: this.planner.activeRevisionKeys(anchor.plan),
        });
        const openCandidate = async (input) => {
            const candidate = index.requireAvailable(input);
            const boundEntry = boundEntryByRevision.get(index.revisionKey(candidate));
            const candidateEnv = await boundEntry.enter();
            return Object.freeze({
                env: candidateEnv,
                implementation: candidateEnv.deps.implementation,
                dispose: () => candidateEnv.dispose(),
                [Symbol.asyncDispose]: () => candidateEnv.dispose(),
            });
        };
        const selector = {
            contract: node.contract,
            candidates: index.candidates,
            *[Symbol.iterator]() { yield* index.candidates; },
            resolve: ref => index.resolve(ref),
            open: openCandidate,
            run: async (input, callback) => {
                const lease = await openCandidate(input);
                return this.executeStructured(lease.env, () => callback(lease.implementation, lease.env));
            },
        };
        return Object.freeze(selector);
    }
    createImplementationSet(node, slot, env) {
        const slotByRevision = new Map();
        for (const revision of node.candidates) {
            slotByRevision.set(revision.key, slot.requires.get(revision.key));
        }
        const index = this.implementationDirectory.createIndex({
            contract: node.contract,
            sourceSlotId: slot.id,
            revisions: node.candidates,
            sitePrefix: `all:${node.contract.id}`,
            parentActiveRevisionKeys: this.planner.activeRevisionKeys(env.plan),
        });
        const implementationSet = {
            contract: node.contract,
            candidates: index.candidates,
            *[Symbol.iterator]() { yield* index.candidates; },
            resolve: ref => index.resolve(ref),
            load: async (input) => {
                const candidate = index.requireAvailable(input);
                return this.materializer.load(slotByRevision.get(index.revisionKey(candidate)));
            },
        };
        return Object.freeze(implementationSet);
    }
    candidateEntry(contract, revision) {
        return Object.freeze({
            kind: 'entry',
            package: internalPackage,
            id: `@syna/core/entry/candidate/${contract.id}/${revision.key}/v1`,
            apiVersion: 1,
            requires: Object.freeze({ implementation: revision }),
            parameters: Object.freeze({}),
            scope: Object.freeze({ fresh: Object.freeze([]), share: Object.freeze([]) }),
            metadata: Object.freeze({}),
        });
    }
    async activateEnv(env, activationTaskId) {
        await this.materializer.activateOwnedEagerSlots(env, env.plan.slotsByNode.values(), activationTaskId);
    }
    async disposeEnv(env) {
        if (env.state === 'disposed' || env.state === 'disposing')
            return;
        env.state = 'disposing';
        const errors = [];
        for (const child of [...env.children]) {
            try {
                await child.dispose();
            }
            catch (error) {
                errors.push(error);
            }
        }
        env.abortController.abort();
        const ownedServiceSlots = [...new Set(env.plan.slotsByNode.values())]
            .filter((slot) => slot.kind === 'service' && slot.ownerEnvId === env.id);
        await this.materializer.settleStartingSlots(ownedServiceSlots);
        errors.push(...await this.materializer.disposeServiceSlots(ownedServiceSlots));
        for (const slot of ownedServiceSlots) {
            if (slot.state === 'dormant' || slot.state === 'failed')
                slot.state = 'disposed';
        }
        env.state = 'disposed';
        env.parent?.children.delete(env);
        this.roots.delete(env);
        this.envById.delete(env.id);
        if (errors.length > 0) {
            throw new AggregateError(errors, `Env ${env.id} failed to dispose cleanly.`);
        }
    }
}
export function createRuntime(options) {
    return new RuntimeImpl(options);
}
//# sourceMappingURL=runtime.js.map
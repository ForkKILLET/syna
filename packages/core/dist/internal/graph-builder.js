import { SynaError } from '../errors.js';
import { satisfiesVersion } from '../semver.js';
import { NeedChoice } from './runtime-model.js';
import { compareRevisionIdentity, providesContract, unwrapDependency, } from './runtime-utils.js';
export class GraphBuilder {
    runtime;
    rootSites;
    inputSlots;
    bindingChoices;
    choices;
    nodes = new Map();
    rootNodeBySite = new Map();
    parentActiveRevisionKeys;
    constructor(runtime, rootSites, inputSlots, bindingChoices, choices, parent) {
        this.runtime = runtime;
        this.rootSites = rootSites;
        this.inputSlots = inputSlots;
        this.bindingChoices = bindingChoices;
        this.choices = choices;
        this.parentActiveRevisionKeys = new Set(parent
            ? [...parent.plan.nodes.values()]
                .filter((node) => node.kind === 'service')
                .map(node => node.revision.key)
            : []);
    }
    build() {
        for (const root of this.rootSites) {
            const nodeId = this.resolveDependency(root.dependency, root.id, root.realm.kind === 'public');
            this.rootNodeBySite.set(root.id, nodeId);
        }
        return { nodes: this.nodes, rootNodeBySite: this.rootNodeBySite };
    }
    resolutionContext(site) {
        return { site, parentActiveRevisionKeys: this.parentActiveRevisionKeys };
    }
    implementationCandidates(contract) {
        this.runtime.registerContract(contract);
        return this.runtime.admittedRevisions
            .filter(revision => providesContract(revision, contract));
    }
    resolveDependency(dependencyInput, site, publicOnly, ownerNodeId) {
        const dependency = unwrapDependency(dependencyInput);
        switch (dependency.kind) {
            case 'service-revision':
                return this.resolveService(this.runtime.canonicalRevision(dependency, publicOnly));
            case 'service-range': {
                this.runtime.registerFamily(dependency.family);
                const candidates = this.runtime.admittedRevisions
                    .filter(revision => revision.family.id === dependency.family.id)
                    .filter(revision => satisfiesVersion(revision.version, dependency.range));
                if (candidates.length === 0) {
                    throw new SynaError('MISSING_SERVICE', `No admitted revision of ${dependency.family.id} satisfies ${dependency.range}.`, { family: dependency.family.id, range: dependency.range, site });
                }
                const ordered = this.runtime.validateCandidateOrder(candidates, this.runtime.policy.orderVersionCandidates(dependency.family, candidates, this.resolutionContext(site)), site);
                return this.resolveChosenRevision(site, ordered, `${dependency.family.id}@${dependency.range}`);
            }
            case 'input': {
                this.runtime.registerInput(dependency);
                if (!this.inputSlots.has(dependency.id)) {
                    throw new SynaError('MISSING_INPUT', `Input ${dependency.id} is required at ${site} but is not provided by this Env lineage.`, { input: dependency.id, site });
                }
                const nodeId = `input:${dependency.id}`;
                if (!this.nodes.has(nodeId)) {
                    this.nodes.set(nodeId, {
                        id: nodeId,
                        kind: 'input',
                        label: dependency.id,
                        edges: new Map(),
                        descriptor: dependency,
                    });
                }
                return nodeId;
            }
            case 'binding': {
                this.runtime.registerBinding(dependency);
                const choice = this.bindingChoices.get(dependency.id);
                if (!choice) {
                    throw new SynaError('MISSING_BINDING', `Binding ${dependency.id} is required at ${site} but has no choice in this Env lineage.`, { binding: dependency.id, site });
                }
                const nodeId = `binding:${dependency.id}`;
                const existing = this.nodes.get(nodeId);
                if (existing)
                    return existing.id;
                const node = {
                    id: nodeId,
                    kind: 'binding',
                    label: `${dependency.id}->${choice.revision.key}`,
                    edges: new Map(),
                    binding: dependency,
                    revision: choice.revision,
                };
                this.nodes.set(nodeId, node);
                node.edges.set('target', this.resolveService(choice.revision));
                return nodeId;
            }
            case 'entry': {
                const nodeId = `entry:${site}:${dependency.id}`;
                const existing = this.nodes.get(nodeId);
                if (existing)
                    return existing.id;
                const owner = ownerNodeId ? this.nodes.get(ownerNodeId) : undefined;
                const realm = owner?.kind === 'service'
                    ? this.runtime.entryRealm(owner.revision, site, dependency)
                    : { kind: 'public', id: 'public' };
                const node = {
                    id: nodeId,
                    kind: 'entry',
                    label: `${dependency.id}@${site}`,
                    edges: new Map(),
                    entry: dependency,
                    dependencySite: site,
                    realm,
                    ...(ownerNodeId ? { anchorNodeId: ownerNodeId } : {}),
                };
                if (ownerNodeId)
                    node.edges.set('anchor', ownerNodeId);
                this.nodes.set(nodeId, node);
                return nodeId;
            }
            case 'contract': {
                const candidates = this.implementationCandidates(dependency);
                if (candidates.length === 0) {
                    throw new SynaError('MISSING_IMPLEMENTATION', `No admitted Service implements Contract ${dependency.id}.`, { contract: dependency.id, site });
                }
                const families = new Set(candidates.map(candidate => candidate.family.id));
                if (families.size > 1) {
                    throw new SynaError('AMBIGUOUS_IMPLEMENTATION', `Contract ${dependency.id} has multiple implementation families at ${site}; use auto(), a Binding, or an exact Service.`, { contract: dependency.id, site, families: [...families].sort() });
                }
                const family = candidates[0].family;
                const ordered = this.runtime.validateCandidateOrder(candidates, this.runtime.policy.orderVersionCandidates(family, candidates, this.resolutionContext(site)), site);
                return this.resolveChosenRevision(site, ordered, `contract(${dependency.id})`);
            }
            case 'auto-implementation': {
                const candidates = this.implementationCandidates(dependency.contract);
                if (candidates.length === 0) {
                    throw new SynaError('MISSING_IMPLEMENTATION', `No admitted Service implements Contract ${dependency.contract.id}.`, { contract: dependency.contract.id, site });
                }
                const ordered = this.runtime.validateCandidateOrder(candidates, this.runtime.policy.orderAutoCandidates(dependency.contract, candidates, this.resolutionContext(site)), site);
                return this.resolveChosenRevision(site, ordered, `auto(${dependency.contract.id})`);
            }
            case 'implementation-selector': {
                const candidates = [...this.implementationCandidates(dependency.contract)]
                    .sort(compareRevisionIdentity);
                const nodeId = `selector:${ownerNodeId ?? site}:${dependency.contract.id}`;
                const existing = this.nodes.get(nodeId);
                if (existing)
                    return existing.id;
                const node = {
                    id: nodeId,
                    kind: 'selector',
                    label: `${dependency.contract.id}[${candidates.map(item => item.key).join(',')}]@${ownerNodeId ?? site}`,
                    edges: new Map(),
                    contract: dependency.contract,
                    candidates,
                    dependencySite: site,
                    ...(ownerNodeId ? { anchorNodeId: ownerNodeId } : {}),
                };
                if (ownerNodeId)
                    node.edges.set('anchor', ownerNodeId);
                this.nodes.set(nodeId, node);
                return nodeId;
            }
            case 'all-implementations': {
                const candidates = [...this.implementationCandidates(dependency.contract)]
                    .sort(compareRevisionIdentity);
                const nodeId = `all:${dependency.contract.id}`;
                const existing = this.nodes.get(nodeId);
                if (existing)
                    return existing.id;
                const node = {
                    id: nodeId,
                    kind: 'all',
                    label: `${dependency.contract.id}[${candidates.map(item => item.key).join(',')}]`,
                    edges: new Map(),
                    contract: dependency.contract,
                    candidates,
                };
                this.nodes.set(nodeId, node);
                for (const candidate of candidates) {
                    node.edges.set(candidate.key, this.resolveService(candidate));
                }
                return nodeId;
            }
        }
    }
    resolveChosenRevision(site, candidates, description) {
        const selectedKey = this.choices.get(site);
        if (selectedKey) {
            const selected = candidates.find(candidate => candidate.key === selectedKey);
            if (!selected) {
                throw new SynaError('CONSTRAINT_VIOLATION', `The inherited resolution ${selectedKey} is no longer valid at ${site}.`, { site, selectedKey, candidates: candidates.map(candidate => candidate.key) });
            }
            return this.resolveService(selected);
        }
        throw new NeedChoice({ site, candidates, description });
    }
    resolveService(inputRevision) {
        const revision = this.runtime.canonicalRevision(inputRevision, false);
        const nodeId = `service:${revision.key}`;
        const existing = this.nodes.get(nodeId);
        if (existing)
            return existing.id;
        const node = {
            id: nodeId,
            kind: 'service',
            label: revision.key,
            edges: new Map(),
            revision,
        };
        this.nodes.set(nodeId, node);
        for (const [key, dependency] of Object.entries(revision.requires)) {
            const site = `service:${revision.key}/dependency:${key}`;
            node.edges.set(key, this.resolveDependency(dependency, site, false, nodeId));
        }
        return nodeId;
    }
}
//# sourceMappingURL=graph-builder.js.map
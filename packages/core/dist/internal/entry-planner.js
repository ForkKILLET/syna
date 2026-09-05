import { SynaError } from '../errors.js';
import { satisfiesVersion } from '../semver.js';
import { DefinitionRegistry } from './definition-registry.js';
import { GraphBuilder } from './graph-builder.js';
import { ImplementationDirectory } from './implementation-directory.js';
import { PlanTemplateCache } from './plan-cache.js';
import { NeedChoice } from './runtime-model.js';
import { dependencyIdentity, isServiceRevision, providesContract, stableJson, } from './runtime-utils.js';
import { isBacktrackableTopologyError } from './solve-errors.js';
function graphSignature(graph, choices) {
    const nodes = [...graph.nodes.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(node => `${node.id}|${node.kind}|${node.label}|${[...node.edges.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, target]) => `${key}->${target}`)
        .join(',')}`);
    const selected = [...choices.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([site, revision]) => `${site}=${revision}`);
    return `${nodes.join(';')}#${selected.join(';')}`;
}
export function entryDefinitionSignature(entry) {
    return stableJson({
        id: entry.id,
        apiVersion: entry.apiVersion,
        requires: Object.fromEntries(Object.entries(entry.requires)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, dependencyIdentity(value)])),
        parameters: Object.fromEntries(Object.entries(entry.parameters)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, `${value.kind}:${value.id}`])),
        scope: {
            fresh: (entry.scope.fresh ?? []).map(scopeTargetIdentity).sort(),
            share: (entry.scope.share ?? []).map(scopeTargetIdentity).sort(),
        },
    });
}
function scopeTargetIdentity(target) {
    return target.kind === 'service-revision'
        ? `revision:${target.key}`
        : `family:${target.id}`;
}
function scopeTargetSet(targets) {
    const revisionKeys = new Set();
    const familyIds = new Set();
    for (const target of targets ?? []) {
        if (target.kind === 'service-revision')
            revisionKeys.add(target.key);
        else
            familyIds.add(target.id);
    }
    return { revisionKeys, familyIds };
}
function targetSetHas(set, revision) {
    return set.revisionKeys.has(revision.key) || set.familyIds.has(revision.family.id);
}
/**
 * Compiles immutable Entry declarations into resolved node graphs and
 * canonical logical slots. It deliberately has no authority to materialize a
 * Service or mutate a live Env.
 */
export class EntryPlanner {
    definitions;
    implementationDirectory;
    policy;
    admittedRevisions;
    planTemplates;
    nextEnvNumber = 1;
    nextSlotNumber = 1;
    constructor(definitions, implementationDirectory, policy, maxCacheEntries) {
        this.definitions = definitions;
        this.implementationDirectory = implementationDirectory;
        this.policy = policy;
        this.admittedRevisions = definitions.admittedRevisions;
        this.planTemplates = new PlanTemplateCache(maxCacheEntries);
    }
    cacheStats() {
        return this.planTemplates.stats();
    }
    clearCache() {
        this.planTemplates.clear();
    }
    plan(parent, descriptor, input, checking, realm) {
        this.definitions.registerEntry(descriptor);
        const envId = `${checking ? 'check' : 'env'}-${this.nextEnvNumber++}`;
        const normalizedInput = (input ?? {});
        const inputSlots = this.prepareInputs(envId, parent, descriptor, normalizedInput);
        const bindingChoices = this.prepareBindings(envId, parent, descriptor, normalizedInput);
        const lineageKey = `${parent?.plan.lineageKey ?? 'root'}>${descriptor.id}`;
        const rootSiteByEntryKey = new Map();
        const rootSites = [...(parent?.plan.rootSites ?? [])];
        for (const [key, dependency] of Object.entries(descriptor.requires)) {
            const rootSite = {
                id: `${lineageKey}/require:${key}`,
                entryId: descriptor.id,
                key,
                dependency,
                realm,
            };
            rootSites.push(rootSite);
            rootSiteByEntryKey.set(key, rootSite.id);
        }
        const fresh = this.mergeScopeTargets(descriptor.scope.fresh, normalizedInput.scope?.fresh);
        const share = this.mergeScopeTargets(descriptor.scope.share, normalizedInput.scope?.share);
        const planInput = {
            envId,
            checking,
            realm,
            lineageKey,
            ...(parent ? { parent } : {}),
            rootSites,
            inputSlots,
            bindingChoices,
            inheritedChoices: parent?.plan.choices ?? new Map(),
            fresh,
            share,
        };
        const templateKey = this.planTemplateKey(parent, descriptor, inputSlots, bindingChoices, fresh, share, realm);
        const cached = this.planTemplates.get(templateKey);
        if (cached) {
            return {
                envId,
                plan: this.assignSlots(planInput, cached.graph, cached.choices, cached.signature),
                rootSiteByEntryKey,
            };
        }
        const solved = this.solvePlanTemplate(planInput, new Map(planInput.inheritedChoices));
        this.planTemplates.set(templateKey, solved.template);
        return { envId, plan: solved.plan, rootSiteByEntryKey };
    }
    inspect(plan) {
        const uniqueSlots = [...new Set(plan.slotsByNode.values())];
        const owned = uniqueSlots.filter(slot => slot.ownerEnvId === plan.envId).length;
        const services = [...plan.nodes.values()]
            .filter((node) => node.kind === 'service');
        return Object.freeze({
            nodeCount: plan.nodes.size,
            ownedSlotCount: owned,
            reusedSlotCount: uniqueSlots.length - owned,
            eagerServiceCount: services.filter(node => node.revision.eager).length,
            selectedRevisions: Object.freeze(Object.fromEntries(plan.choices)),
        });
    }
    activeRevisionKeys(plan) {
        if (!plan)
            return new Set();
        return new Set([...plan.nodes.values()]
            .filter((node) => node.kind === 'service')
            .map(node => node.revision.key));
    }
    canonicalRevision(revision, publicOnly) {
        return this.definitions.canonicalRevision(revision, publicOnly);
    }
    entryRealm(owner, dependencySite, entry) {
        return this.definitions.entryRealm(owner, dependencySite, entry);
    }
    registerFamily(family) {
        this.definitions.registerFamily(family);
    }
    registerContract(contract) {
        this.definitions.registerContract(contract);
    }
    registerInput(input) {
        this.definitions.registerInput(input);
    }
    registerBinding(binding) {
        this.definitions.registerBinding(binding);
    }
    validateCandidateOrder(original, ordered, site) {
        return this.implementationDirectory.validateOrder(original, ordered, site);
    }
    planTemplateKey(parent, descriptor, parameters, bindings, fresh, share, realm) {
        const inputShape = [...parameters.keys()].sort().join(',');
        const bindingShape = [...bindings.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, choice]) => `${id}=${choice.revision.key}`)
            .join(',');
        const scopeShape = (targets) => [
            ...[...targets.revisionKeys].map(key => `revision:${key}`),
            ...[...targets.familyIds].map(id => `family:${id}`),
        ].sort().join(',');
        return [
            parent?.plan.signature ?? 'root',
            `lineage=${parent?.plan.lineageKey ?? 'root'}`,
            `realm=${realm.id}`,
            entryDefinitionSignature(descriptor),
            `parameters=${inputShape}`,
            `bindings=${bindingShape}`,
            `fresh=${scopeShape(fresh)}`,
            `share=${scopeShape(share)}`,
        ].join('|');
    }
    solvePlanTemplate(input, choices) {
        try {
            const graph = new GraphBuilder(this, input.rootSites, input.inputSlots, input.bindingChoices, choices, input.parent).build();
            const signature = graphSignature(graph, choices);
            const template = Object.freeze({
                graph,
                choices: new Map(choices),
                signature,
            });
            return {
                template,
                plan: this.assignSlots(input, graph, choices, signature),
            };
        }
        catch (error) {
            if (!(error instanceof NeedChoice))
                throw error;
            const failures = [];
            for (const candidate of error.data.candidates) {
                const nextChoices = new Map(choices);
                nextChoices.set(error.data.site, candidate.key);
                try {
                    return this.solvePlanTemplate(input, nextChoices);
                }
                catch (candidateError) {
                    if (!isBacktrackableTopologyError(candidateError))
                        throw candidateError;
                    failures.push(candidateError);
                }
            }
            throw new SynaError('UNSATISFIABLE_TOPOLOGY', `No candidate can satisfy ${error.data.description} at ${error.data.site}.`, {
                site: error.data.site,
                candidates: error.data.candidates.map(candidate => candidate.key),
                failures: failures.map(failure => ({ code: failure.code, message: failure.message })),
            }, failures[0] ? { cause: failures[0] } : undefined);
        }
    }
    assignSlots(input, graph, choices, signature) {
        const activeServices = [...graph.nodes.values()]
            .filter((node) => node.kind === 'service');
        this.validateScopeTargets(input.fresh, activeServices, 'fresh', input.envId);
        this.validateScopeTargets(input.share, activeServices, 'share', input.envId);
        const reusable = new Map();
        const parentPlan = input.parent?.plan;
        if (parentPlan) {
            for (const node of graph.nodes.values()) {
                const parentNode = parentPlan.nodes.get(node.id);
                if (!parentNode || parentNode.kind !== node.kind || parentNode.label !== node.label)
                    continue;
                const parentSlot = parentPlan.slotsByNode.get(node.id);
                if (!parentSlot)
                    continue;
                if (node.kind === 'input') {
                    if (input.inputSlots.get(node.descriptor.id) === parentSlot)
                        reusable.set(node.id, parentSlot);
                    continue;
                }
                if (node.kind === 'service' && targetSetHas(input.fresh, node.revision))
                    continue;
                reusable.set(node.id, parentSlot);
            }
            const reverse = new Map();
            for (const node of graph.nodes.values()) {
                for (const target of node.edges.values()) {
                    const dependants = reverse.get(target) ?? new Set();
                    dependants.add(node.id);
                    reverse.set(target, dependants);
                }
            }
            const dependenciesMatch = (nodeId) => {
                const node = graph.nodes.get(nodeId);
                if (node.kind === 'input')
                    return true;
                const parentNode = parentPlan.nodes.get(nodeId);
                if (!parentNode)
                    return false;
                for (const [edge, targetId] of node.edges) {
                    const parentTargetId = parentNode.edges.get(edge);
                    if (!parentTargetId)
                        return false;
                    const expectedSlot = parentPlan.slotsByNode.get(parentTargetId);
                    const currentTargetNode = graph.nodes.get(targetId);
                    const currentSlot = currentTargetNode.kind === 'input'
                        ? input.inputSlots.get(currentTargetNode.descriptor.id)
                        : reusable.get(targetId);
                    if (!expectedSlot || currentSlot !== expectedSlot)
                        return false;
                }
                return true;
            };
            const queue = [];
            for (const nodeId of reusable.keys()) {
                if (!dependenciesMatch(nodeId))
                    queue.push(nodeId);
            }
            const queued = new Set(queue);
            while (queue.length > 0) {
                const nodeId = queue.shift();
                queued.delete(nodeId);
                if (!reusable.delete(nodeId))
                    continue;
                for (const dependant of reverse.get(nodeId) ?? []) {
                    if (reusable.has(dependant) && !queued.has(dependant)) {
                        queue.push(dependant);
                        queued.add(dependant);
                    }
                }
            }
        }
        for (const node of activeServices) {
            if (!targetSetHas(input.share, node.revision))
                continue;
            if (!reusable.has(node.id)) {
                throw new SynaError('SHARE_CONSTRAINT_FAILED', `${node.revision.key} cannot reuse its parent-visible slot in Env ${input.envId}.`, { revision: node.revision.key, env: input.envId });
            }
        }
        const slotsByNode = new Map();
        for (const node of graph.nodes.values()) {
            if (node.kind === 'input') {
                slotsByNode.set(node.id, input.inputSlots.get(node.descriptor.id));
                continue;
            }
            const inherited = reusable.get(node.id);
            if (inherited) {
                slotsByNode.set(node.id, inherited);
                continue;
            }
            if (node.kind === 'service') {
                const slot = {
                    kind: 'service',
                    id: this.allocateSlotId(),
                    ownerEnvId: input.envId,
                    revision: node.revision,
                    requires: new Map(),
                    state: 'dormant',
                    cleanups: [],
                    attempts: 0,
                    generation: 0,
                };
                slotsByNode.set(node.id, slot);
            }
            else {
                const slot = {
                    kind: node.kind,
                    id: this.allocateSlotId(),
                    ownerEnvId: input.envId,
                    state: 'ready',
                    requires: new Map(),
                };
                slotsByNode.set(node.id, slot);
            }
        }
        for (const node of graph.nodes.values()) {
            if (reusable.has(node.id) || node.kind === 'input')
                continue;
            const slot = slotsByNode.get(node.id);
            for (const [edge, targetNodeId] of node.edges) {
                slot.requires.set(edge, slotsByNode.get(targetNodeId));
            }
        }
        const anchors = new Map(input.parent?.plan.anchors ?? []);
        const uniqueByFamily = new Map();
        for (const node of activeServices) {
            if (node.revision.family.uniqueWithin !== 'lineage')
                continue;
            const slot = slotsByNode.get(node.id);
            const list = uniqueByFamily.get(node.revision.family.id) ?? [];
            list.push(slot);
            uniqueByFamily.set(node.revision.family.id, list);
        }
        for (const [familyId, slots] of uniqueByFamily) {
            const distinct = [...new Set(slots)];
            const anchor = anchors.get(familyId);
            if (anchor) {
                if (distinct.some(slot => slot !== anchor)) {
                    throw new SynaError('LINEAGE_UNIQUENESS_CONFLICT', `Lineage-unique Service Family ${familyId} cannot diverge below its anchor.`, { family: familyId, anchorSlot: anchor.id, attemptedSlots: distinct.map(slot => slot.id) });
                }
            }
            else {
                if (distinct.length > 1) {
                    throw new SynaError('LINEAGE_UNIQUENESS_CONFLICT', `Lineage-unique Service Family ${familyId} would create multiple slots in one lineage.`, { family: familyId, slots: distinct.map(slot => slot.id) });
                }
                if (distinct[0])
                    anchors.set(familyId, distinct[0]);
            }
        }
        return {
            nodes: graph.nodes,
            rootNodeBySite: graph.rootNodeBySite,
            slotsByNode,
            rootSites: input.rootSites,
            inputSlots: input.inputSlots,
            bindingChoices: input.bindingChoices,
            choices: new Map(choices),
            anchors,
            signature,
            lineageKey: input.lineageKey,
            envId: input.envId,
            checking: input.checking,
        };
    }
    validateScopeTargets(targets, active, kind, envId) {
        const activeKeys = new Set(active.map(node => node.revision.key));
        const activeFamilies = new Set(active.map(node => node.revision.family.id));
        for (const key of targets.revisionKeys) {
            if (!activeKeys.has(key)) {
                throw new SynaError('CONSTRAINT_VIOLATION', `${kind} targets inactive Service Revision ${key}.`, { env: envId, revision: key });
            }
        }
        for (const family of targets.familyIds) {
            if (!activeFamilies.has(family)) {
                throw new SynaError('CONSTRAINT_VIOLATION', `${kind} targets inactive Service Family ${family}.`, { env: envId, family });
            }
        }
    }
    mergeScopeTargets(first, second) {
        const left = scopeTargetSet(first);
        const right = scopeTargetSet(second);
        const revisionKeys = new Set();
        const familyIds = new Set();
        for (const key of [...left.revisionKeys, ...right.revisionKeys]) {
            const effective = this.definitions.effectiveRevisionByKey(key);
            if (!effective) {
                revisionKeys.add(key);
                continue;
            }
            revisionKeys.add(effective.key);
            familyIds.add(effective.family.id);
        }
        for (const familyId of [...left.familyIds, ...right.familyIds]) {
            const effectiveIds = this.definitions.effectiveFamilyIds(familyId);
            if (effectiveIds.length === 0)
                familyIds.add(familyId);
            else
                for (const effectiveId of effectiveIds)
                    familyIds.add(effectiveId);
        }
        return { revisionKeys, familyIds };
    }
    prepareInputs(envId, parent, descriptor, input) {
        const result = new Map(parent?.plan.inputSlots ?? []);
        const provided = input;
        for (const [key, parameter] of Object.entries(descriptor.parameters)) {
            if (parameter.kind !== 'input')
                continue;
            this.registerInput(parameter);
            if (!(key in provided)) {
                throw new SynaError('MISSING_INPUT', `Entry ${descriptor.id} requires an input for ${key} (${parameter.id}).`, { entry: descriptor.id, key, input: parameter.id });
            }
            const slot = Object.freeze({
                kind: 'input',
                id: this.allocateSlotId(),
                ownerEnvId: envId,
                descriptor: parameter,
                payload: provided[key],
                state: 'ready',
                requires: new Map(),
            });
            result.set(parameter.id, slot);
        }
        return result;
    }
    prepareBindings(envId, parent, descriptor, input) {
        const result = new Map(parent?.plan.bindingChoices ?? []);
        const assignments = input;
        for (const [key, parameter] of Object.entries(descriptor.parameters)) {
            if (parameter.kind !== 'binding')
                continue;
            this.registerBinding(parameter);
            if (!(key in assignments)) {
                throw new SynaError('MISSING_BINDING', `Entry ${descriptor.id} requires an assignment for ${key} (${parameter.id}).`, { entry: descriptor.id, key, binding: parameter.id });
            }
            const revision = this.resolveBindingAssignment(parameter, assignments[key], parent?.plan);
            const inherited = result.get(parameter.id);
            // Binding equality is nominal and decidable; selecting the same exact
            // revision is deliberately a no-op, unlike re-providing an Input.
            if (inherited?.revision.key === revision.key)
                continue;
            result.set(parameter.id, Object.freeze({
                id: this.allocateChoiceId(),
                ownerEnvId: envId,
                binding: parameter,
                revision,
            }));
        }
        return result;
    }
    resolveBindingAssignment(binding, assignment, parentPlan) {
        let revision;
        if (isServiceRevision(assignment)) {
            revision = this.canonicalRevision(assignment, true);
        }
        else {
            if (assignment.kind !== 'persistent-implementation-ref') {
                throw new SynaError('INVALID_DESCRIPTOR', `Invalid assignment for Binding ${binding.id}.`);
            }
            if (assignment.contractId !== binding.contract.id) {
                throw new SynaError('INCOMPATIBLE_IMPLEMENTATION', `Implementation reference for ${assignment.contractId} cannot satisfy Binding ${binding.id} (${binding.contract.id}).`);
            }
            const candidates = this.implementationDirectory
                .candidatesForImplementationId(assignment.implementationId)
                .filter(candidate => satisfiesVersion(candidate.version, assignment.version))
                .filter(candidate => providesContract(candidate, binding.contract));
            if (candidates.length === 0) {
                throw new SynaError('MISSING_IMPLEMENTATION', `No admitted ${assignment.implementationId} revision satisfies ${assignment.version} and ${binding.contract.id}.`, { binding: binding.id, implementation: assignment.implementationId, version: assignment.version });
            }
            const site = `binding:${binding.id}`;
            revision = this.validateCandidateOrder(candidates, this.policy.orderVersionCandidates(candidates[0].family, candidates, {
                site,
                parentActiveRevisionKeys: this.activeRevisionKeys(parentPlan),
            }), site)[0];
        }
        if (!providesContract(revision, binding.contract)) {
            throw new SynaError('INCOMPATIBLE_IMPLEMENTATION', `${revision.key} does not provide Contract ${binding.contract.id}.`, { binding: binding.id, revision: revision.key });
        }
        return revision;
    }
    allocateSlotId() {
        return `slot-${this.nextSlotNumber++}`;
    }
    allocateChoiceId() {
        return `choice-${this.nextSlotNumber++}`;
    }
}
//# sourceMappingURL=entry-planner.js.map
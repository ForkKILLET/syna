import { AsyncLocalStorage } from 'node:async_hooks';
import { SynaError } from '../errors.js';
import { dependantFirstComponentOrder, stronglyConnectedComponents, } from '../graph.js';
import { abortError, assertNotAborted, sleepAbortable } from './abort.js';
import { createDependencyRef } from './runtime-utils.js';
/**
 * Owns every operational concern of Service slots. Topology planning remains
 * outside this class: the materializer can only realize already-created slots.
 */
export class Materializer {
    waitEdges = new Map();
    context = new AsyncLocalStorage();
    completionCounter = 1;
    activeFrame() {
        const frame = this.context.getStore();
        return frame?.active && frame.slot.state === 'starting' ? frame : undefined;
    }
    trackStrongOperation(operation, frame = this.activeFrame()) {
        if (!frame)
            return operation;
        frame.strongLoads.add(operation);
        // The barrier still awaits the original promise. This observer only keeps
        // deliberately un-awaited strong loads from becoming unhandled rejections.
        void operation.catch(() => undefined);
        return operation;
    }
    createRef(slot) {
        return createDependencyRef(() => this.load(slot), () => this.preload(slot));
    }
    load(slot) {
        const frame = this.activeFrame();
        return this.trackStrongOperation(this.resolveSlot(slot, frame?.slot), frame);
    }
    preload(slot) {
        void this.resolveSlot(slot, undefined).catch(() => undefined);
    }
    currentRequester() {
        return this.activeFrame()?.slot;
    }
    addWaitEdge(from, to, fromLabel = from, toLabel = to) {
        const edges = this.waitEdges.get(from) ?? new Set();
        edges.add(to);
        this.waitEdges.set(from, edges);
        if (this.hasWaitPath(to, from)) {
            this.removeWaitEdge(from, to);
            throw new SynaError('CIRCULAR_MATERIALIZATION', `Circular materialization wait detected between ${fromLabel} and ${toLabel}.`, { from, to, fromLabel, toLabel });
        }
    }
    removeWaitEdge(from, to) {
        const edges = this.waitEdges.get(from);
        if (!edges)
            return;
        edges.delete(to);
        if (edges.size === 0)
            this.waitEdges.delete(from);
    }
    async activateOwnedEagerSlots(env, slots, activationTaskId) {
        const eagerSlots = [...new Set(slots)]
            .filter((slot) => slot.kind === 'service'
            && slot.ownerEnvId === env.id
            && slot.revision.eager);
        await Promise.all(eagerSlots.map(async (slot) => {
            this.addWaitEdge(activationTaskId, slot.id, `Env ${env.id} activation`, slot.revision.key);
            try {
                await this.resolveServiceSlot(slot);
            }
            finally {
                this.removeWaitEdge(activationTaskId, slot.id);
            }
        }));
    }
    async settleStartingSlots(slots) {
        for (const slot of slots) {
            if (slot.state !== 'starting' || !slot.starting)
                continue;
            try {
                await slot.starting;
            }
            catch { /* setup rollback has already run */ }
        }
    }
    async disposeServiceSlots(slotsInput) {
        const errors = [];
        const disposable = slotsInput.filter(slot => slot.state === 'ready');
        const adjacency = this.serviceDependencyAdjacency(disposable);
        const scc = stronglyConnectedComponents(adjacency);
        const componentOrder = dependantFirstComponentOrder(adjacency, scc);
        const byId = new Map(disposable.map(slot => [slot.id, slot]));
        for (const componentIndex of componentOrder) {
            const slots = scc.components[componentIndex]
                .map(id => byId.get(id))
                .filter((slot) => slot !== undefined)
                .sort((left, right) => (right.completionOrder ?? 0) - (left.completionOrder ?? 0));
            for (const slot of slots) {
                try {
                    await this.disposeServiceSlot(slot);
                }
                catch (error) {
                    errors.push(error);
                }
            }
        }
        return errors;
    }
    async resolveSlot(slot, requester) {
        switch (slot.kind) {
            case 'input': return slot.payload;
            case 'binding': return this.resolveSlot(slot.requires.get('target'), requester);
            case 'selector':
            case 'all':
            case 'entry': return slot.value;
            case 'service': return this.resolveServiceSlot(slot, requester);
        }
    }
    async resolveServiceSlot(slot, requester) {
        if (slot.state === 'ready')
            return slot.instance;
        if (slot.state === 'disposing' || slot.state === 'disposed') {
            throw new SynaError('INVALID_ENV_STATE', `Service slot ${slot.id} is ${slot.state}.`, { slot: slot.id, revision: slot.revision.key });
        }
        let promise;
        if (slot.state === 'failed') {
            if (slot.revision.failure.afterExhaustion === 'sticky')
                throw slot.error;
            promise = this.recoverFailedSlot(slot);
        }
        else {
            if (slot.state === 'dormant')
                this.startServiceSlot(slot);
            promise = slot.starting;
        }
        if (requester?.state === 'starting') {
            return this.awaitWithMaterializationEdge(requester, slot, promise);
        }
        return promise;
    }
    recoverFailedSlot(slot) {
        if (slot.recovery)
            return slot.recovery;
        if (!slot.ownerEnv) {
            return Promise.reject(new SynaError('INVALID_ENV_STATE', `Service slot ${slot.id} has no owner Env.`));
        }
        const owner = slot.ownerEnv;
        const recovery = (async () => {
            this.assertOwnerUsable(owner, slot, 'recover');
            const elapsed = Date.now() - (slot.failedAt ?? 0);
            const remaining = Math.max(0, slot.revision.failure.cooldownMs - elapsed);
            await sleepAbortable(remaining, owner.abortController.signal, `Recovery for ${slot.revision.key} was cancelled because owner Env ${owner.id} is closing.`);
            this.assertOwnerUsable(owner, slot, 'recover');
            if (slot.state === 'ready')
                return slot.instance;
            if (slot.state !== 'failed') {
                if (slot.starting)
                    return slot.starting;
                throw new SynaError('INVALID_ENV_STATE', `Cannot recover ${slot.revision.key} from state ${slot.state}.`);
            }
            delete slot.error;
            delete slot.failedAt;
            delete slot.starting;
            slot.state = 'dormant';
            this.startServiceSlot(slot);
            return slot.starting;
        })();
        slot.recovery = recovery;
        void recovery.finally(() => {
            if (slot.recovery === recovery)
                delete slot.recovery;
        }).catch(() => undefined);
        return recovery;
    }
    startServiceSlot(slot) {
        if (slot.state !== 'dormant')
            return;
        if (!slot.ownerEnv) {
            throw new SynaError('INVALID_ENV_STATE', `Service slot ${slot.id} has no owner Env.`);
        }
        this.assertOwnerUsable(slot.ownerEnv, slot, 'materialize');
        slot.state = 'starting';
        const generation = ++slot.generation;
        slot.starting = this.runSetupSequence(slot, generation);
        void slot.starting.catch(() => undefined);
    }
    async runSetupSequence(slot, generation) {
        const owner = slot.ownerEnv;
        const signal = owner.abortController.signal;
        const policy = slot.revision.failure;
        let sequenceAttempt = 0;
        while (sequenceAttempt < policy.attempts) {
            this.assertOwnerUsable(owner, slot, 'continue setup');
            sequenceAttempt += 1;
            slot.attempts += 1;
            const frame = {
                slot,
                strongLoads: new Set(),
                active: true,
            };
            const dependencyRefs = {};
            for (const [key, dependencySlot] of slot.requires) {
                dependencyRefs[key] = this.createRef(dependencySlot);
            }
            const lifecycle = {
                signal,
                onDispose: cleanup => {
                    if (slot.state !== 'starting' || slot.generation !== generation) {
                        throw new SynaError('INVALID_ENV_STATE', `onDispose() for ${slot.revision.key} may only be called during its active setup attempt.`);
                    }
                    slot.cleanups.push(cleanup);
                },
            };
            try {
                const instance = await this.context.run(frame, () => slot.revision.setup(Object.freeze(dependencyRefs), lifecycle));
                await this.drainStrongLoads(frame);
                frame.active = false;
                this.assertOwnerUsable(owner, slot, 'complete setup');
                if (slot.generation !== generation || slot.state !== 'starting') {
                    throw new SynaError('INVALID_ENV_STATE', `Setup generation for ${slot.revision.key} is no longer current.`);
                }
                slot.instance = instance;
                delete slot.error;
                delete slot.failedAt;
                slot.state = 'ready';
                slot.completionOrder = this.completionCounter++;
                return instance;
            }
            catch (error) {
                frame.active = false;
                const cleanupErrors = await this.runCleanups(slot);
                const effectiveError = cleanupErrors.length === 0
                    ? error
                    : new AggregateError([error, ...cleanupErrors.map(item => item.error)], `Setup attempt for ${slot.revision.key} and its rollback both failed.`, error instanceof Error ? { cause: error } : undefined);
                const mayRetry = sequenceAttempt < policy.attempts
                    && !signal.aborted
                    && (owner.state === 'activating' || owner.state === 'ready');
                if (mayRetry) {
                    await sleepAbortable(policy.delayMs, signal, `Retry of ${slot.revision.key} was cancelled because owner Env ${owner.id} is closing.`);
                    continue;
                }
                slot.error = effectiveError;
                slot.failedAt = Date.now();
                slot.state = 'failed';
                throw effectiveError;
            }
        }
        const exhausted = new SynaError('INVALID_ENV_STATE', `Service ${slot.revision.key} exhausted setup attempts.`);
        slot.error = exhausted;
        slot.failedAt = Date.now();
        slot.state = 'failed';
        throw exhausted;
    }
    async drainStrongLoads(frame) {
        // New strong loads may be registered while an earlier batch settles.
        while (frame.strongLoads.size > 0) {
            const batch = [...frame.strongLoads];
            frame.strongLoads.clear();
            await Promise.all(batch);
        }
    }
    assertOwnerUsable(owner, slot, action) {
        assertNotAborted(owner.abortController.signal, `${action} of ${slot.revision.key} was cancelled because owner Env ${owner.id} is closing.`);
        if (owner.state !== 'activating' && owner.state !== 'ready') {
            throw abortError(`Cannot ${action} ${slot.revision.key} while owner Env ${owner.id} is ${owner.state}.`);
        }
    }
    async awaitWithMaterializationEdge(requester, target, promise) {
        this.addWaitEdge(requester.id, target.id, requester.revision.key, target.revision.key);
        try {
            return await promise;
        }
        finally {
            this.removeWaitEdge(requester.id, target.id);
        }
    }
    hasWaitPath(from, target) {
        const visited = new Set();
        const stack = [from];
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === target)
                return true;
            if (visited.has(current))
                continue;
            visited.add(current);
            stack.push(...(this.waitEdges.get(current) ?? []));
        }
        return false;
    }
    serviceDependencyAdjacency(slots) {
        const included = new Set(slots.map(slot => slot.id));
        const adjacency = new Map();
        const collect = (slot, visited, output) => {
            if (visited.has(slot.id))
                return;
            visited.add(slot.id);
            if (slot.kind === 'service') {
                if (included.has(slot.id))
                    output.add(slot.id);
                return;
            }
            for (const dependency of slot.requires.values())
                collect(dependency, visited, output);
        };
        for (const slot of slots) {
            const targets = new Set();
            for (const dependency of slot.requires.values())
                collect(dependency, new Set(), targets);
            adjacency.set(slot.id, targets);
        }
        return adjacency;
    }
    async disposeServiceSlot(slot) {
        if (slot.state !== 'ready')
            return;
        slot.state = 'disposing';
        const errors = await this.runCleanups(slot);
        slot.state = 'disposed';
        delete slot.instance;
        if (errors.length > 0) {
            throw new AggregateError(errors.map(item => item.error), `Service ${slot.revision.key} failed to dispose cleanly.`);
        }
    }
    async runCleanups(slot) {
        const errors = [];
        for (const cleanup of slot.cleanups.splice(0).reverse()) {
            try {
                await cleanup();
            }
            catch (error) {
                errors.push({ slot: slot.id, error });
            }
        }
        return errors;
    }
}
//# sourceMappingURL=materializer.js.map
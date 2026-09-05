import type { DependencyRef } from '../descriptors.js';
import type { EnvState, MaterializationFrame, RuntimeSlot, ServiceSlot } from './runtime-model.js';
export interface MaterializerEnv {
    readonly id: string;
    readonly state: EnvState;
    readonly abortController: AbortController;
}
/**
 * Owns every operational concern of Service slots. Topology planning remains
 * outside this class: the materializer can only realize already-created slots.
 */
export declare class Materializer {
    private readonly waitEdges;
    private readonly context;
    private completionCounter;
    activeFrame(): MaterializationFrame | undefined;
    trackStrongOperation<T>(operation: Promise<T>, frame?: MaterializationFrame | undefined): Promise<T>;
    createRef<T>(slot: RuntimeSlot): DependencyRef<T>;
    load<T>(slot: RuntimeSlot): Promise<T>;
    preload(slot: RuntimeSlot): void;
    currentRequester(): ServiceSlot | undefined;
    addWaitEdge(from: string, to: string, fromLabel?: string, toLabel?: string): void;
    removeWaitEdge(from: string, to: string): void;
    activateOwnedEagerSlots(env: MaterializerEnv, slots: Iterable<RuntimeSlot>, activationTaskId: string): Promise<void>;
    settleStartingSlots(slots: Iterable<ServiceSlot>): Promise<void>;
    disposeServiceSlots(slotsInput: readonly ServiceSlot[]): Promise<readonly unknown[]>;
    private resolveSlot;
    private resolveServiceSlot;
    private recoverFailedSlot;
    private startServiceSlot;
    private runSetupSequence;
    private drainStrongLoads;
    private assertOwnerUsable;
    private awaitWithMaterializationEdge;
    private hasWaitPath;
    private serviceDependencyAdjacency;
    private disposeServiceSlot;
    private runCleanups;
}
//# sourceMappingURL=materializer.d.ts.map
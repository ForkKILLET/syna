export interface CacheStats {
    readonly hits: number;
    readonly misses: number;
    readonly entries: number;
    readonly evictions: number;
    readonly maxEntries: number;
}
/**
 * Small deterministic LRU used for compiled Entry-plan templates.
 * Keys must describe semantic plan shape and must never contain Env/slot ids.
 */
export declare class PlanTemplateCache<Value> {
    readonly maxEntries: number;
    private readonly values;
    private hitCount;
    private missCount;
    private evictionCount;
    constructor(maxEntries: number);
    get(key: string): Value | undefined;
    set(key: string, value: Value): void;
    stats(): CacheStats;
    clear(): void;
}
//# sourceMappingURL=plan-cache.d.ts.map
/**
 * Small deterministic LRU used for compiled Entry-plan templates.
 * Keys must describe semantic plan shape and must never contain Env/slot ids.
 */
export class PlanTemplateCache {
    maxEntries;
    values = new Map();
    hitCount = 0;
    missCount = 0;
    evictionCount = 0;
    constructor(maxEntries) {
        this.maxEntries = maxEntries;
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new TypeError('planCache.maxEntries must be a positive safe integer.');
        }
    }
    get(key) {
        const value = this.values.get(key);
        if (value === undefined) {
            this.missCount += 1;
            return undefined;
        }
        this.hitCount += 1;
        // Refresh recency without changing value identity.
        this.values.delete(key);
        this.values.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.values.has(key))
            this.values.delete(key);
        this.values.set(key, value);
        while (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next().value;
            if (oldest === undefined)
                break;
            this.values.delete(oldest);
            this.evictionCount += 1;
        }
    }
    stats() {
        return Object.freeze({
            hits: this.hitCount,
            misses: this.missCount,
            entries: this.values.size,
            evictions: this.evictionCount,
            maxEntries: this.maxEntries,
        });
    }
    clear() {
        this.values.clear();
    }
}
//# sourceMappingURL=plan-cache.js.map
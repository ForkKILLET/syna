export interface CacheStats {
  readonly hits: number
  readonly misses: number
  readonly entries: number
  readonly evictions: number
  readonly limit: number
}

/**
 * Small deterministic LRU used for compiled Entry-plan templates.
 * Keys must describe semantic plan shape and must never contain Env/slot ids.
 */
export class PlanTemplateCache<Value> {
  private readonly values = new Map<string, Value>()
  private hitCount = 0
  private missCount = 0
  private evictionCount = 0

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('limits.planCacheEntries must be a positive safe integer.')
    }
  }

  get(key: string): Value | undefined {
    const value = this.values.get(key)
    if (value === undefined) {
      this.missCount += 1
      return undefined
    }
    this.hitCount += 1
    // Refresh recency without changing value identity.
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  set(key: string, value: Value): void {
    if (this.values.has(key)) this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.values.delete(oldest)
      this.evictionCount += 1
    }
  }

  stats(): CacheStats {
    return Object.freeze({
      hits: this.hitCount,
      misses: this.missCount,
      entries: this.values.size,
      evictions: this.evictionCount,
      limit: this.limit,
    })
  }

  /** Evict one template, e.g. when it no longer fits the parent it was verified against. */
  delete(key: string): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }
}

// Bounded LRU page cache for the Reader display path (Agent C, C5). PDF.js-free and
// React-free — pure storage so eviction / capacity / MRU semantics are node-testable.
//
// The Reader only ever needs a tiny working set (current page ± neighbor prefetch), so
// the cache is deliberately STRICT: a 600-page textbook never gets fully cached. On
// eviction the owning value (e.g. an ImageBitmap) is disposed via the configured
// onEvict hook, so no large surface leaks.

export type BoundCacheEvictionHandler<V> = (value: V, key: string) => void

/** A strictly-bounded LRU cache keyed by string (page key like '10'). */
export class BoundedPageCache<V> {
  readonly capacity: number
  private readonly map = new Map<string, V>()
  private readonly order: string[] = []
  private readonly onEvict?: BoundCacheEvictionHandler<V>

  constructor(capacity: number, onEvict?: BoundCacheEvictionHandler<V>) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.onEvict = onEvict
  }

  get size(): number { return this.map.size }
  has(key: string): boolean { return this.map.has(key) }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.touch(key)
    return v
  }

  put(key: string, value: V): { evicted: V | null } {
    if (this.map.has(key)) {
      this.map.set(key, value)
      this.touch(key)
      return { evicted: null }
    }
    let evicted: V | null = null
    if (this.order.length >= this.capacity) {
      const oldest = this.order.pop() as string
      evicted = this.map.get(oldest) as V
      this.map.delete(oldest)
      if (this.onEvict) this.onEvict(evicted, oldest)
    }
    this.map.set(key, value)
    this.order.unshift(key)
    return { evicted }
  }

  delete(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      const idx = this.order.indexOf(key)
      if (idx >= 0) this.order.splice(idx, 1)
    }
    return v
  }

  clear(): void {
    this.map.clear()
    this.order.length = 0
  }

  keys(): string[] { return [...this.order] }

  private touch(key: string): void {
    const idx = this.order.indexOf(key)
    if (idx > 0) {
      this.order.splice(idx, 1)
      this.order.unshift(key)
    }
  }
}

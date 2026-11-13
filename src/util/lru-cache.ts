/**
 * A minimal size-bounded cache, evicting the least recently used entry when full.
 * Relies on Map preserving insertion order, re-inserting entries on each read.
 */
export class LruCache<K, V extends {}> {

    private readonly entries = new Map<K, V>();

    constructor(
        private readonly maxSize: number
    ) {
        if (!Number.isInteger(maxSize) || maxSize < 1) {
            throw new Error(`LRU cache size must be a positive integer, got ${maxSize}`);
        }
    }

    get size() {
        return this.entries.size;
    }

    get(key: K): V | undefined {
        const value = this.entries.get(key);
        if (value === undefined) return undefined;

        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    set(key: K, value: V) {
        this.entries.delete(key);
        this.entries.set(key, value);

        if (this.entries.size > this.maxSize) {
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
    }

    delete(key: K) {
        return this.entries.delete(key);
    }

}

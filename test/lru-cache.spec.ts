import { LruCache } from "../src/util/lru-cache";
import { expect } from "./test-utils";

describe("LRU cache", () => {

    it("returns stored values", () => {
        const cache = new LruCache<string, number>(2);
        cache.set('a', 1);

        expect(cache.get('a')).to.equal(1);
        expect(cache.get('b')).to.equal(undefined);
    });

    it("evicts the oldest entry when full", () => {
        const cache = new LruCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        expect(cache.size).to.equal(2);
        expect(cache.get('a')).to.equal(undefined);
        expect(cache.get('b')).to.equal(2);
        expect(cache.get('c')).to.equal(3);
    });

    it("treats reads as recent use", () => {
        const cache = new LruCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a');
        cache.set('c', 3);

        expect(cache.get('a')).to.equal(1);
        expect(cache.get('b')).to.equal(undefined);
        expect(cache.get('c')).to.equal(3);
    });

    it("replaces existing entries without evicting others", () => {
        const cache = new LruCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('a', 10);

        expect(cache.size).to.equal(2);
        expect(cache.get('a')).to.equal(10);
        expect(cache.get('b')).to.equal(2);
    });

    it("deletes entries", () => {
        const cache = new LruCache<string, number>(2);
        cache.set('a', 1);

        expect(cache.delete('a')).to.equal(true);
        expect(cache.get('a')).to.equal(undefined);
        expect(cache.size).to.equal(0);
    });

    it("rejects sizes that aren't positive integers", () => {
        for (const size of [0, -1, 1.5, NaN, Infinity]) {
            expect(() => new LruCache<string, number>(size)).to.throw();
        }
    });

    it("stays bounded under many distinct keys", () => {
        const cache = new LruCache<number, number>(10);
        for (let i = 0; i < 1000; i++) cache.set(i, i);

        expect(cache.size).to.equal(10);
        expect(cache.get(989)).to.equal(undefined);
        expect(cache.get(990)).to.equal(990);
    });

});

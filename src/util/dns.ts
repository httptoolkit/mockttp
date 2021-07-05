import * as dns from 'dns';

// A drop-in alternative to dns.lookup, but where results are briefly cached to avoid completely unnecessary lookups,
// while remaining fairly reactive to actual host file changes etc.
export class CachedDns {

    private cache = new Map<string, [address: string | dns.LookupAddress[], family: number]>();

    constructor(
        private cacheDurationMs: number
    ) {}

    private cacheKey(hostname: Parameters<typeof dns.lookup>[0], options?: dns.LookupAllOptions | dns.LookupOneOptions) {
        return `${hostname}-${options?.all}-${options?.family}-${options?.hints}-${options?.verbatim}`;
    }

    lookup = (...args: Parameters<typeof dns.lookup>) => {
        const [hostname, options] = args.slice(0, -1) as [string, dns.LookupOptions | undefined];
        const cb = args[args.length - 1] as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void;

        const key = this.cacheKey(hostname, options);
        const cachedResult = this.cache.get(key);
        if (cachedResult) {
            setImmediate(() => cb(null, ...cachedResult));
        } else {
            dns.lookup(hostname, options ?? {}, (err, ...cbArgs) => {
                if (!err) {
                    this.cache.set(key, cbArgs);
                    // Always refresh Xms after initially inserted - no LRU or similar
                    setTimeout(() => this.cache.delete(key), this.cacheDurationMs).unref();
                }
                return cb(err, ...cbArgs);
            });
        }
    }

}
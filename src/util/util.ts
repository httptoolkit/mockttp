export function nthIndexOf(input: string, matcher: string, n: number) {
    let index = -1;

    while (n > 0) {
        n = n - 1;
        index = input.indexOf(matcher, index + 1);
        if (index === -1) break;
    }

    return index;
}

// Get the length of the given data in bytes, not characters.
// If that's a buffer, the length is used raw, but if it's a string
// it returns the length when encoded as UTF8.
export function byteLength(input: string | Uint8Array | Buffer) {
    if (typeof input === 'string') {
        return isNode
            ? Buffer.from(input, 'utf8').byteLength
            : new Blob([input]).size;
    } else {
        return input.length;
    }
}

export function delay(t: number): Promise<void> {
    return new Promise((r) => setTimeout(r, t));
}

declare const WorkerGlobalScope: Function | undefined;
export const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
export const isWeb = typeof Window !== 'undefined' && self instanceof Window;
export const isNode = !isWorker && !isWeb && typeof process === 'object' && process.version;

export const makePropertyWritable = <T>(obj: T, property: keyof T) =>
    Object.defineProperty(obj, property, {
        value: obj[property],
        writable: true
    });
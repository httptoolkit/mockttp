export function nthIndexOf(input: string, matcher: string, n: number) {
    let index = -1;

    while (n > 0) {
        n = n - 1;
        index = input.indexOf(matcher, index + 1);
        if (index === -1) break;
    }

    return index;
}

// Get the length of the given string in bytes, not characters.
// Assumes the string will be encoded as UTF8
export function byteLength(input: string) {
    return isNode
        ? Buffer.from(input, 'utf8').byteLength
        : new Blob([input]).size;
}


declare const WorkerGlobalScope: Function | undefined;
export const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
export const isWeb = typeof Window !== 'undefined' && self instanceof Window;
export const isNode = !isWorker && !isWeb && typeof process === 'object' && process.version;
export function nthIndexOf(input: string, matcher: string, n: number) {
    let index = -1;

    while (n > 0) {
        n = n - 1;
        index = input.indexOf(matcher, index + 1);
        if (index === -1) break;
    }

    return index;
}


declare const WorkerGlobalScope: Function | undefined;
export const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
export const isWeb = typeof Window !== 'undefined' && self instanceof Window;
export const isNode = !isWorker && !isWeb && typeof process === 'object' && process.version;
import _ = require("lodash");
import { MaybePromise } from "./type-utils";

export async function filter<T>(
    array: T[],
    test: (t: T) => MaybePromise<boolean>
): Promise<T[]> {
    let testResults = await Promise.all(array.map(test));
    return array.filter((v, i) => testResults[i]);
}

export async function objectAllPromise<V>(obj: _.Dictionary<MaybePromise<V>>): Promise<_.Dictionary<V>> {
    return _.zipObject(Object.keys(obj), await Promise.all(Object.values(obj)));
}

export type Deferred<T> = Promise<T> & {
    resolve(value: T): void,
    reject(e: Error): void
}
export function getDeferred<T>(): Deferred<T> {
    let resolveCallback: (value: T) => void;
    let rejectCallback: (e: Error) => void;
    let result = <Deferred<T>> new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });
    result.resolve = resolveCallback!;
    result.reject = rejectCallback!;

    return result;
}
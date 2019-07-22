/**
 * @module Internal
 */

import { MaybePromise } from "./type-utils";

export async function filter<T>(
    array: T[],
    test: (t: T) => MaybePromise<boolean>
): Promise<T[]> {
    let testResults = await Promise.all(array.map(test));
    return array.filter((v, i) => testResults[i]);
}
import _ from 'lodash';
import type { Dictionary } from 'lodash';
import { MaybePromise } from "@httptoolkit/util";

export async function filter<T>(
    array: T[],
    test: (t: T) => MaybePromise<boolean>
): Promise<T[]> {
    let testResults = await Promise.all(array.map(test));
    return array.filter((v, i) => testResults[i]);
}

export async function objectAllPromise<V>(obj: Dictionary<MaybePromise<V>>): Promise<Dictionary<V>> {
    return _.zipObject(Object.keys(obj), await Promise.all(Object.values(obj)));
}
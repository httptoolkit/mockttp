export async function filter<T>(
    array: T[],
    test: (t: T) => Promise<boolean> | boolean
): Promise<T[]> {
    let testResults = await Promise.all(array.map(test));
    return array.filter((v, i) => testResults[i]);
}
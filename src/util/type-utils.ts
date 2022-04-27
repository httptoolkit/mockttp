export type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;

// Turns T, making all props K required
export type RequireProps<T, K extends keyof T> =
    Omit<T, K> & Required<Pick<T, K>>;

export type MaybePromise<T> = T | Promise<T>;

type SubsetKeyOf<T, Ks extends keyof T = keyof T> = Ks;
export type Replace<T, KV extends { [K in SubsetKeyOf<T, any>]: unknown }> =
    Omit<T, keyof KV> & { [K in keyof KV]: KV[K] };

export type Mutable<T> = {
    -readonly [K in keyof T]: T[K]
}
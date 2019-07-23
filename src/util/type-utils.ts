export type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;

// Turns T, making all props K required
export type RequireProps<T, K extends keyof T> =
    Omit<T, K> & Required<Pick<T, K>>;

export type MaybePromise<T> = T | Promise<T>;

export type Replace<T, K extends keyof T, V> =
    Omit<T, K> & { [k in K]: V };
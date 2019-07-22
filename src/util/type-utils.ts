// Turns T, making all props K required
export type RequireProps<T, K extends keyof T> =
    Pick<T, Exclude<keyof T, K>> & Required<Pick<T, K>>;

export type MaybePromise<T> = T | Promise<T>;
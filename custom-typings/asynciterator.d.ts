interface SymbolConstructor {
    /**
     * A reference to the prototype.
     */
    readonly prototype: Symbol;

    /**
     * Returns a new unique Symbol value.
     * @param  description Description of the new Symbol object.
     */
    (description?: string | number): symbol;

    /**
     * Returns a Symbol object from the global symbol registry matching the given key if found.
     * Otherwise, returns a new symbol with this key.
     * @param key key to search for.
     */
    for(key: string): symbol;

    /**
     * Returns a key from the global symbol registry matching the given Symbol if found.
     * Otherwise, returns a undefined.
     * @param sym Symbol to find the key for.
     */
    keyFor(sym: symbol): string | undefined;

    /**
     * A method that returns the default async iterator for an object. Called by the semantics of
     * the for-await-of statement.
     */
    readonly asyncIterator: symbol;
}

declare var Symbol: SymbolConstructor;

declare interface AsyncIterator<T> {
    next(value?: any): Promise<IteratorResult<T>>;
    return?(value?: any): Promise<IteratorResult<T>>;
    throw?(e?: any): Promise<IteratorResult<T>>;
}

declare interface AsyncIterable<T> {
    [Symbol.asyncIterator](): AsyncIterator<T>;
}

declare interface AsyncIterableIterator<T> extends AsyncIterator<T> {
    [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}
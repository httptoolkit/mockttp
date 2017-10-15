declare module 'fetch-ponyfill' {
    function getFetch(): {
        fetch: typeof fetch,
        Headers: typeof Headers,
        Request: typeof Request,
        Response: typeof Response
    }

    export = getFetch;
}
declare module 'fetch-ponyfill' {
    function getFetchPonyfill(): {
        fetch: typeof fetch,
        Headers: typeof Headers,
        Request: typeof Request,
        Response: typeof Response
    }

    export = getFetchPonyfill;
}
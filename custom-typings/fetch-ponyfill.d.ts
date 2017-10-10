declare module 'fetch-ponyfill' {
    function getFetch(): {
        fetch: typeof fetch,
        Headers: Headers,
        Request: Request,
        Response: Response
    }

    export = getFetch;
}
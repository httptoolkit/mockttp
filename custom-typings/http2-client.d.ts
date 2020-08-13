declare module 'http2-client' {
    import { request, get } from 'https';

    // Exactly the same interface as built-in HTTP/1 requests:
    export { request, get };
}
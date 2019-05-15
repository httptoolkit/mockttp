declare module 'https-proxy-agent' {
    import { Agent } from 'https';

    class HttpsProxyAgent extends Agent {
        constructor (uri: string | { protocol?: string; host?: string; hostname?: string; port?: number });
    }

    export = HttpsProxyAgent;
}
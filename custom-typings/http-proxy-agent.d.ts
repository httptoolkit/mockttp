declare module 'http-proxy-agent' {
    import { Agent } from 'http';

    class HttpProxyAgent extends Agent {
        constructor (uri: string | { protocol?: string; host?: string; hostname?: string; port?: number });
    }

    export = HttpProxyAgent;
}
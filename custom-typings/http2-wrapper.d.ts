declare module 'http2-wrapper' {
    // From https://github.com/szmarczak/http2-wrapper/blob/0fd01089f3dc119929aedcdd5e3751c867fee14d/index.d.ts
    // This should be removed once those types are properly published
    import {EventEmitter} from 'events';
    import {TLSSocket} from 'tls';
    import http = require('http');
    import {RequestOptions} from 'https';
    import http2 = require('http2');

    export interface AgentOptions {
        timeout?: number;
        maxSessions?: number;
        maxFreeSessions?: number;
        maxCachedTlsSessions?: number;
    }

    export interface PromiseListeners {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }

    export class Agent extends EventEmitter {
        freeSessions: {[key: string]: http2.ClientHttp2Stream[]};
        busySessions: {[key: string]: http2.ClientHttp2Stream[]};

        constructor(options: AgentOptions);

        static normalizeOrigin(url: string | URL, servername?: string): string;

        static connect(origin: URL, options: http2.SecureClientSessionOptions): TLSSocket;

        normalizeOptions(options: http2.ClientSessionRequestOptions): string;

        getSession(origin: string | URL, options?: http2.SecureClientSessionOptions, listeners?: PromiseListeners): Promise<http2.ClientHttp2Session>;
        request(origin: string | URL, options?: http2.SecureClientSessionOptions, headers?: http2.OutgoingHttpHeaders, streamOptions?: http2.ClientSessionRequestOptions): Promise<http2.ClientHttp2Stream>;

        createConnection(origin: URL, options: http2.SecureClientSessionOptions): TLSSocket;

        closeFreeSessions(): void;
        destroy(reason?: Error): void;
    }

    export interface RequestFunction<T> {
        (url: string | URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): T;
        (options: RequestOptions, callback?: (response: IncomingMessage) => void): T;
    }

    export import ClientRequest = http.ClientRequest;
    export import IncomingMessage = http.IncomingMessage;

    export const globalAgent: Agent;

    export const request: RequestFunction<ClientRequest>;
    export const get: RequestFunction<ClientRequest>;
    export const auto: RequestFunction<Promise<ClientRequest>>;

    export * from 'http2';
}
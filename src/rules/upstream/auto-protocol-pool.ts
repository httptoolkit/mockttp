import * as https from 'https';
import type * as http2 from 'http2';
import type * as tls from 'tls';
import { CustomError } from '@httptoolkit/util';

import { AbortError } from '../../util/abort-error';
import { h2HeadersToH1, rawHeadersToObject } from '../../util/header-utils';
import { formatHostAndPort } from '../../util/url';
import { dialTls } from './tls-dial';
import { H1Connection } from './h1-connection';
import { H2Connection } from './h2-connection';
import type {
    UpstreamExchange,
    UpstreamRequestHead,
    UpstreamRequestHooks,
    UpstreamRequestSpec
} from './upstream-exchange';

type UpstreamConnection = H1Connection | H2Connection;

/** Everything we hold for one destination: connections are only shared within one of these. */
interface Destination {
    h1Connections: Set<H1Connection>;
    h2Connections: Set<H2Connection>;
    /** Settles once the latest connection attempt has joined the pool, or failed. */
    pendingConnection: Promise<void> | undefined;
    tlsSession: Buffer | undefined;
}

const DEFAULT_ALPN_PROTOCOLS = ['h2', 'http/1.1'];

const getAlpnProtocols = (tlsOptions: tls.ConnectionOptions): string[] => {
    const configured = tlsOptions.ALPNProtocols;
    return Array.isArray(configured) && configured.every((p) => typeof p === 'string')
        ? configured
        : DEFAULT_ALPN_PROTOCOLS;
};

// Node's agent defines when two TLS configurations are interchangeable, so we reuse its
// rules. It ignores secure contexts and lookup functions though, which can differ between
// rules (for TLS fingerprint mirroring and custom DNS), so we key on their identities too.
const keyingAgent = new https.Agent();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const getObjectId = (value: object | undefined) => {
    if (!value) return 0;
    let id = objectIds.get(value);
    if (id === undefined) {
        id = nextObjectId++;
        objectIds.set(value, id);
    }
    return id;
};

const getDestinationKey = ({ hostname, port, family, lookup, tlsOptions }: UpstreamRequestSpec) => [
    keyingAgent.getName({ ...tlsOptions, host: hostname, port, family }),
    getAlpnProtocols(tlsOptions).join(','),
    getObjectId(tlsOptions.secureContext),
    getObjectId(lookup)
].join('|');

// Requests here come from HTTP/2 clients, so their headers are valid for HTTP/2 as they are.
// Node sends headers in object order, so this is the order they reach the server:
const toH2Headers = ({ method, path, rawHeaders }: UpstreamRequestHead): http2.OutgoingHttpHeaders => ({
    ':method': method,
    ':path': path,
    ...rawHeadersToObject(rawHeaders)
});

const toH1Head = (head: UpstreamRequestHead): UpstreamRequestHead => ({
    ...head,
    rawHeaders: h2HeadersToH1(head.rawHeaders, head.method)
});

/** Wait for a promise, unless the signal aborts first, which rejects with its reason. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

/**
 * Sends HTTPS requests from HTTP/2 clients, over whichever protocol each upstream
 * connection negotiates via ALPN. All connections belong to a single downstream
 * connection, and are destroyed with it.
 *
 * Requests use an HTTP/2 connection with spare capacity or an idle HTTP/1 connection if
 * there is one. Otherwise they wait for an in-progress connection attempt that might turn
 * out to be HTTP/2, or open a new connection of their own.
 */
export class AutoProtocolPool {
    private readonly destinations = new Map<string, Destination>();
    private readonly lifetime = new AbortController();

    async send(requestSpec: UpstreamRequestSpec, hooks: UpstreamRequestHooks): Promise<UpstreamExchange> {
        hooks.signal.throwIfAborted();
        const destination = this.getDestination(requestSpec);

        // Wait for in-progress connections that could be HTTP/2, so concurrent requests share H2
        // sessions where possible. If we already have HTTP/1 connections, then we know that's
        // preferred, so we skip waiting and go in parallel.
        while (true) {
            const existing = this.sendOnExisting(destination, requestSpec, hooks);
            if (existing) return existing;

            if (!destination.pendingConnection || destination.h1Connections.size > 0) break;
            await abortable(destination.pendingConnection, hooks.signal);
        }

        return this.sendOnNew(destination, requestSpec, hooks);
    }

    private getDestination(requestSpec: UpstreamRequestSpec): Destination {
        const key = getDestinationKey(requestSpec);
        let destination = this.destinations.get(key);
        if (!destination) {
            destination = {
                h1Connections: new Set(),
                h2Connections: new Set(),
                pendingConnection: undefined,
                tlsSession: undefined
            };
            this.destinations.set(key, destination);
        }
        return destination;
    }

    private sendOnExisting(
        destination: Destination,
        requestSpec: UpstreamRequestSpec,
        hooks: UpstreamRequestHooks
    ): UpstreamExchange | undefined {
        for (const connection of destination.h2Connections) {
            if (connection.canTakeStream) return connection.send(toH2Headers(requestSpec), hooks);
        }
        for (const connection of destination.h1Connections) {
            if (connection.isIdle) return connection.send(toH1Head(requestSpec), hooks);
        }
        return undefined;
    }

    /**
     * Open a new connection, and send this request on it first. Once that's done (or this
     * request has given up) the connection joins the pool for anybody else.
     */
    private async sendOnNew(
        destination: Destination,
        requestSpec: UpstreamRequestSpec,
        hooks: UpstreamRequestHooks
    ): Promise<UpstreamExchange> {
        const firstUse = this.connect(destination, requestSpec).then((connection) => {
            try {
                return hooks.signal.aborted
                    ? {}
                    : { exchange: this.sendFirstRequest(connection, requestSpec, hooks) };
            } catch (error) {
                return { error };
            } finally {
                this.trackConnection(destination, connection);
            }
        });

        // Others can wait for this: it rejects only if we fail to connect.
        const pendingConnection = firstUse.then(() => {});
        destination.pendingConnection = pendingConnection;
        pendingConnection.catch(() => {}).finally(() => {
            if (destination.pendingConnection === pendingConnection) {
                destination.pendingConnection = undefined;
            }
        });

        const { exchange, error } = await abortable(firstUse, hooks.signal);
        if (error) throw error;
        if (!exchange) throw hooks.signal.reason;
        return exchange;
    }

    private async connect(
        destination: Destination,
        requestSpec: UpstreamRequestSpec
    ): Promise<UpstreamConnection> {
        const { signal } = this.lifetime;
        const socket = await dialTls({
            ...requestSpec.tlsOptions,
            host: requestSpec.hostname,
            port: requestSpec.port,
            family: requestSpec.family,
            lookup: requestSpec.lookup,
            ALPNProtocols: getAlpnProtocols(requestSpec.tlsOptions),
            session: destination.tlsSession,
            keyLogStream: requestSpec.keyLogStream,
            onSession: (session) => { destination.tlsSession = session; }
        }, signal);

        if (socket.alpnProtocol !== 'h2') return new H1Connection(socket);

        const originHost = requestSpec.tlsOptions.servername || requestSpec.hostname;
        const origin = `https://${formatHostAndPort(originHost, requestSpec.port)}`;
        return H2Connection.open(socket, origin, signal);
    }

    private sendFirstRequest(
        connection: UpstreamConnection,
        requestSpec: UpstreamRequestSpec,
        hooks: UpstreamRequestHooks
    ): UpstreamExchange {
        if (connection instanceof H1Connection) return connection.send(toH1Head(requestSpec), hooks);

        // A fresh session that can't take even one stream (zero capacity, or an immediate
        // GOAWAY) won't do any better for anybody else, so we fail rather than retry:
        if (!connection.canTakeStream) {
            connection.destroy();
            throw new CustomError(
                'Upstream HTTP/2 server would not accept any requests on a new connection',
                { code: 'ERR_HTTP2_OUT_OF_STREAMS' }
            );
        }
        return connection.send(toH2Headers(requestSpec), hooks);
    }

    private trackConnection(destination: Destination, connection: UpstreamConnection) {
        if (this.lifetime.signal.aborted) return connection.destroy();
        if (connection.isClosed) return;

        if (connection instanceof H2Connection) {
            destination.h2Connections.add(connection);
            connection.onClose(() => destination.h2Connections.delete(connection));
        } else {
            destination.h1Connections.add(connection);
            connection.onClose(() => destination.h1Connections.delete(connection));
        }
    }

    destroy(): void {
        this.lifetime.abort(new AbortError(
            'Downstream connection closed before the upstream connection could be established',
            'E_DOWNSTREAM_ABORT'
        ));
        for (const destination of this.destinations.values()) {
            for (const connection of destination.h1Connections) connection.destroy();
            for (const connection of destination.h2Connections) connection.destroy();
        }
        this.destinations.clear();
    }
}

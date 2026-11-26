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
    /**
     * Whether the latest connection negotiated HTTP/1. Every connection still negotiates
     * for itself: this only predicts whether one that's in progress is worth waiting for.
     */
    expectH1: boolean;
    tlsSession: Buffer | undefined;
}

const DEFAULT_CONNECTION_WAIT_LIMIT = 3000;

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

const toH1Head = (requestSpec: UpstreamRequestSpec): UpstreamRequestHead => ({
    ...requestSpec,
    rawHeaders: h2HeadersToH1(requestSpec.rawHeaders, requestSpec.endStream)
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

/** Wait for a promise as above, but only for so long: once the time is up, this resolves. */
function waitUpTo(promise: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeLimit = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    return abortable(Promise.race([promise, timeLimit]), signal).finally(() => clearTimeout(timer));
}

/**
 * Controls one connection attempt, which is aborted along with the pool. It's also abandoned
 * if it outlasts the time limit and the request that wanted it has gone. Until then, the
 * connection is worth finishing for other requests, but after that it has probably stalled.
 */
function controlAttempt(poolSignal: AbortSignal, requestSignal: AbortSignal, timeLimit: number) {
    const controller = new AbortController();
    const attempt = {
        signal: controller.signal,
        abandoned: false,
        release: () => {
            clearTimeout(timer);
            poolSignal.removeEventListener('abort', abortWithPool);
            requestSignal.removeEventListener('abort', abandonIfUnwanted);
        }
    };

    const abortWithPool = () => controller.abort(poolSignal.reason);
    poolSignal.addEventListener('abort', abortWithPool, { once: true });

    let overdue = false;
    const abandonIfUnwanted = () => {
        if (!overdue || !requestSignal.aborted) return;
        attempt.abandoned = true;
        controller.abort();
    };
    const timer = setTimeout(() => {
        overdue = true;
        abandonIfUnwanted();
    }, timeLimit);
    requestSignal.addEventListener('abort', abandonIfUnwanted, { once: true });

    return attempt;
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

    /**
     * @param connectionWaitLimit How long (in ms) a request waits for a connection that
     * another request is opening, and how long a connection can take once the request
     * that wanted it has gone.
     */
    constructor(private readonly connectionWaitLimit = DEFAULT_CONNECTION_WAIT_LIMIT) {}

    async send(requestSpec: UpstreamRequestSpec, hooks: UpstreamRequestHooks): Promise<UpstreamExchange> {
        hooks.signal.throwIfAborted();
        const destination = this.getDestination(requestSpec);

        // Wait for in-progress connections that could be HTTP/2, so concurrent requests share H2
        // sessions where possible. If the server last negotiated HTTP/1 then we expect that
        // again, so we skip waiting and go in parallel. The wait is also limited, so that a
        // stalled connection can't hold up every other request.
        const waitDeadline = Date.now() + this.connectionWaitLimit;
        while (true) {
            const existing = this.sendOnExisting(destination, requestSpec, hooks);
            if (existing) return existing;

            const waitRemaining = waitDeadline - Date.now();
            if (!destination.pendingConnection || destination.expectH1 || waitRemaining <= 0) break;
            await waitUpTo(destination.pendingConnection, waitRemaining, hooks.signal);
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
                expectH1: false,
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
            if (connection.canTakeStream) {
                return connection.send(toH2Headers(requestSpec), hooks, requestSpec.endStream);
            }
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
        this.lifetime.signal.throwIfAborted();
        const attempt = controlAttempt(this.lifetime.signal, hooks.signal, this.connectionWaitLimit);

        const firstUse = this.connect(destination, requestSpec, attempt.signal).then((connection) => {
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

        // Others can wait for this. It rejects only if we fail to connect: if we abandon
        // the attempt ourselves, they just carry on without it.
        const pendingConnection = firstUse.then(() => {}, (error) => {
            if (!attempt.abandoned) throw error;
        });
        destination.pendingConnection = pendingConnection;
        pendingConnection.catch(() => {}).finally(() => {
            attempt.release();
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
        requestSpec: UpstreamRequestSpec,
        signal: AbortSignal
    ): Promise<UpstreamConnection> {
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

        destination.expectH1 = socket.alpnProtocol !== 'h2';
        if (destination.expectH1) return new H1Connection(socket);

        const originHost = requestSpec.tlsOptions.servername || requestSpec.hostname;
        const origin = `https://${formatHostAndPort(originHost, requestSpec.port)}`;
        try {
            return await H2Connection.open(socket, origin, signal);
        } catch (error) {
            socket.destroy();
            throw error;
        }
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
        return connection.send(toH2Headers(requestSpec), hooks, requestSpec.endStream);
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

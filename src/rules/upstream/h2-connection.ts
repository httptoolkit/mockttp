import * as http2 from 'http2';
import type * as tls from 'tls';
import { CustomError } from '@httptoolkit/util';

import { awaitReady } from './await-ready';
import { startH2Exchange } from './h2-exchange';
import type { UpstreamExchange, UpstreamRequestHooks } from './upstream-exchange';

// Node 27's default flow-control windows, used on every version for consistency. Older
// defaults (64KB) throttle transfers over any real latency.
const SESSION_SETTINGS: http2.Settings = {
    enablePush: false,
    initialWindowSize: 4 * 1024 * 1024
};
const CONNECTION_WINDOW_SIZE = 32 * 1024 * 1024;

// Options that Node supports for clients, but its typings don't declare
const UNTYPED_SESSION_OPTIONS: { connectionWindowSize: number, strictSingleValueFields: boolean } = {
    connectionWindowSize: CONNECTION_WINDOW_SIZE,
    strictSingleValueFields: false
};

/**
 * One established HTTP/2 connection, carrying as many concurrent requests as the server
 * allows, until it closes (which Node does itself on GOAWAY).
 */
export class H2Connection {

    /**
     * Start a session on a socket that negotiated HTTP/2. This resolves once the server's
     * settings arrive, since until then we don't know how many streams it will accept.
     */
    static async open(socket: tls.TLSSocket, origin: string, signal: AbortSignal): Promise<H2Connection> {
        const session = http2.connect(origin, {
            createConnection: () => socket,
            settings: SESSION_SETTINGS,
            ...UNTYPED_SESSION_OPTIONS
        });

        await awaitReady(session, 'remoteSettings', signal, () => new CustomError(
            'Upstream HTTP/2 session closed before sending its settings',
            { code: 'ERR_HTTP2_INVALID_SESSION' }
        ));
        // We also set this after connect(), to handle Node versions that don't support the option:
        session.setLocalWindowSize(CONNECTION_WINDOW_SIZE);
        return new H2Connection(session, socket);
    }

    private readonly activeStreams = new Set<http2.ClientHttp2Stream>();

    private constructor(
        private readonly session: http2.ClientHttp2Session,
        private readonly socket: tls.TLSSocket
    ) {
        // Session failures fail each of its streams, which report them individually:
        session.on('error', () => {});
        session.unref();
    }

    get isClosed(): boolean {
        return this.session.closed || this.session.destroyed;
    }

    get canTakeStream(): boolean {
        return !this.isClosed &&
            this.activeStreams.size < (this.session.remoteSettings.maxConcurrentStreams ?? Infinity);
    }

    send(headers: http2.OutgoingHttpHeaders, hooks: UpstreamRequestHooks): UpstreamExchange {
        const stream = this.session.request(headers, { signal: hooks.signal });

        this.activeStreams.add(stream);
        this.session.ref();
        stream.once('close', () => {
            this.activeStreams.delete(stream);
            if (this.activeStreams.size === 0) this.session.unref();
        });

        return startH2Exchange(stream, this.socket, hooks);
    }

    onClose(callback: () => void): void {
        this.session.once('close', callback);
    }

    destroy(): void {
        // Node ends a destroyed session's streams as if they'd completed, with nothing to
        // show otherwise, so we cancel them first:
        for (const stream of this.activeStreams) stream.close(http2.constants.NGHTTP2_CANCEL);
        this.session.destroy();
    }
}

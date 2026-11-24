import * as https from 'https';
import type * as tls from 'tls';
import type { Duplex } from 'stream';

import { startH1Exchange } from './h1-exchange';
import type {
    UpstreamExchange,
    UpstreamRequestHead,
    UpstreamRequestHooks
} from './upstream-exchange';

/**
 * Lends Node's keep-alive handling exactly one existing socket. It never connects: once
 * that socket closes, requests fail on it rather than opening a replacement.
 */
class SingleSocketAgent extends https.Agent {
    constructor(private readonly socket: Duplex) {
        super({ keepAlive: true, maxSockets: 1 });
    }

    override createConnection(): Duplex {
        return this.socket;
    }
}

/**
 * One established HTTP/1 connection, carrying one request at a time.
 */
export class H1Connection {
    private readonly agent: SingleSocketAgent;
    private busy = false;

    constructor(private readonly socket: tls.TLSSocket) {
        this.agent = new SingleSocketAgent(socket);
        this.agent.on('free', () => { this.busy = false; });
        // Errors on an active socket are reported via its request; otherwise it just closes:
        socket.on('error', () => {});
    }

    get isClosed(): boolean {
        // Once the server has closed its side, the socket is unusable, though it's
        // not destroyed until shortly afterwards:
        return this.socket.destroyed || !this.socket.readable;
    }

    get isIdle(): boolean {
        return !this.busy && !this.isClosed;
    }

    send(head: UpstreamRequestHead, hooks: UpstreamRequestHooks): UpstreamExchange {
        const exchange = startH1Exchange('https:', { agent: this.agent }, head, hooks);
        this.busy = true;
        return exchange;
    }

    onClose(callback: () => void): void {
        this.socket.once('close', callback);
    }

    destroy(): void {
        this.agent.destroy();
        this.socket.destroy();
    }
}

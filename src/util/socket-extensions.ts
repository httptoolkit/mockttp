import type * as streams from 'stream';
import type * as net from 'net';
import type * as tls from 'tls';
import { TlsSocketMetadata } from '../types';

// We store a bunch of metadata that we directly attach to sockets, TLS
// sockets, and HTTP/2 streams to track our state over time & through tunneling:
export const InitialRemoteAddress = Symbol('initial-remote-address');
export const InitialRemotePort = Symbol('initial-port-address');
export const TlsSetupCompleted = Symbol('tls-setup-comleted');
export const LastHopEncrypted = Symbol('last-hop-encrypted');
export const LastTunnelAddress = Symbol('last-hop-address');
export const TlsMetadata = Symbol('tls-metadata');
export const ClientErrorInProgress = Symbol('client-error-in-progress');
export const SocketTimingInfo = Symbol('socket-timing-info');
export const SocketMetadata = Symbol('socket-metadata');

export interface SocketMetadata {
    tags?: string[];
    [key: string]: any;
}

declare module 'net' {
    interface Socket {
        /**
         * Is this socket trying to send encrypted data upstream? For direct connections
         * this always matches socket.encrypted. For CONNECT-proxied connections (where
         * the initial connection could be HTTPS and the upstream connection HTTP, or
         * vice versa) all on one socket, this is the value for the final hop.
         */
        [LastHopEncrypted]?: boolean;
        /**
         * The hostname + maybe port from the inner-most tunnel request powering this
         * socket. This is the best signal for the client's real target address,
         * if provided. It's not set at all for direct (non-tunnelled) connections.
         */
        [LastTunnelAddress]?: string;

        /**
         * If there's a client error being sent, we track the corresponding packet
         * data on the socket, so that when it fires repeatedly we can combine them
         * into a single response & error event.
         */
        [ClientErrorInProgress]?: { rawPacket?: Buffer };

        /**
         * Our recordings of various timestamps, used for monitoring &
         * performance analysis later on
         */
        [SocketTimingInfo]?: {
            initialSocket: number; // Initial raw socket time, since unix epoch

            // High-precision timestamps:
            initialSocketTimestamp: number;
            tunnelSetupTimestamp?: number; // Latest CONNECT completion, if any
            tlsConnectedTimestamp?: number; // Latest TLS handshake completion, if any
            lastRequestTimestamp?: number; // Latest request or websocket request time, if any
        }

        // Set on TLSSocket, defined here for convenient access on _all_ sockets
        [TlsMetadata]?: TlsSocketMetadata;
        [InitialRemoteAddress]?: string;
        [InitialRemotePort]?: number;

        /**
         * Arbitrary custom metadata that may be added during socket processing,
         * e.g. with the SOCKS custom-metadata auth extension.
         *
         * Currently the only metadata that is exposed is `tags`, which are
         * attached to each request on this connection with a `socket-metadata:`
         * prefix. This can be used to provide tags during SOCKS connection
         * setup that will then be visible on all 'response' event data (for
         * example) later on.
         */
        [SocketMetadata]?: SocketMetadata;
    }
}

declare module 'tls' {
    interface TLSSocket {
        /**
         * Have we seen evidence that the client has completed & trusts the connection?
         * If set, we know that errors are client errors, not TLS setup/trust issues.
         */
        [TlsSetupCompleted]?: boolean;

        /**
         * Extra metadata attached to a TLS socket, taken from the client hello and
         * preceeding tunneling steps.
         */
        [TlsMetadata]?: TlsSocketMetadata;

        /**
         * We cache this extra metadata during the initial TLS setup on these separate
         * properties, because it can be cleared & lost from the socket in some
         * TLS error scenarios.
         */
        [InitialRemoteAddress]?: string;
        [InitialRemotePort]?: number;
    }
}

declare module 'http2' {
    class Http2Session {
        // session.socket is cleared before error handling kicks in. That's annoying,
        // so we manually preserve the socket elsewhere to work around it.
        initialSocket?: net.Socket;
    }

    class ServerHttp2Stream {
        // Treated the same as net.Socket, when we unwrap them in our combo server:
        [LastHopEncrypted]?: net.Socket[typeof LastHopEncrypted];
        [LastTunnelAddress]?: net.Socket[typeof LastTunnelAddress];
        [SocketTimingInfo]?: net.Socket[typeof SocketTimingInfo];
        [SocketMetadata]?: SocketMetadata;
    }
}

export type SocketIsh<MinProps extends keyof net.Socket & keyof tls.TLSSocket> =
    streams.Duplex &
    Partial<Pick<net.Socket, MinProps>> &
    Partial<Pick<tls.TLSSocket, MinProps>>;
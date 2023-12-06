// There's a few places where we attach extra data to some node objects during
// connection setup etc, to better track data & handle issues:

declare module "net" {
    import * as net from 'net';
    import * as streams from 'stream';

    interface Socket {
        // Is this socket trying to send encrypted data upstream? For direct connections
        // this always matches socket.encrypted. For CONNECT-proxied connections (where
        // the initial connection could be HTTPS and the upstream connection HTTP, or
        // vice versa) all on one socket, this is the value for the final hop.
        __lastHopEncrypted?: boolean;

        // For CONNECT-based socket tunnels, this is the address that was listed in the
        // last layer of the tunnelling so far.
        __lastHopConnectAddress?: string;

        // Extra metadata attached to a TLS socket, taken from the client hello and
        // preceeding tunneling steps.
        __tlsMetadata?: {}; // Can't ref Mockttp real type here

        // Normally only defined on TLSSocket, but useful to explicitly include here
        // Undefined on plain HTTP, 'true' on TLSSocket.
        encrypted?: boolean;

        // If there's a client error being sent, we track the corresponding packet
        // data on the socket, so that when it fires repeatedly we can combine them
        // into a single response & error event.
        clientErrorInProgress?: { rawPacket?: Buffer; }

        // Our recordings of various timestamps, used for monitoring &
        // performance analysis later on
        __timingInfo?: {
            initialSocket: number; // Initial raw socket time, since unix epoch

            // High-precision timestamps:
            initialSocketTimestamp: number;
            tunnelSetupTimestamp?: number; // Latest CONNECT completion, if any
            tlsConnectedTimestamp?: number; // Latest TLS handshake completion, if any
        };

        // Internal reference to the parent socket, available on TLS sockets
        _parent?: Socket;

        // Internal reference to the underlying stream, available on _stream_wrap
        stream?: streams.Duplex & Partial<net.Socket>;
    }
}

declare module "tls" {
    import SocketWrapper = require('_stream_wrap');

    interface TLSSocket {
        // This is a real field that actually exists - unclear why it's not
        // in the type definitions.
        servername?: string;

        // We cache the initially set remote address & port on sockets, because it's cleared
        // before the TLS error callback is called, exactly when we want to read it.
        initialRemoteAddress?: string;
        initialRemotePort?: number;

        // Marker used to detect whether client errors should be reported as TLS issues
        // (RST during handshake) or as subsequent client issues (RST during request)
        tlsSetupCompleted?: true;

        _handle?: { // Internal, used for monkeypatching & error tracking
            oncertcb?: (info: any) => any;
            _parentWrap?: SocketWrapper;
        }
    }
}

// Undocumented module that allows us to turn a stream into a usable net.Socket.
// Deprecated in Node 12+, but I'm hopeful that that will be cancelled...
// Necessary for our HTTP2 re-CONNECT handling, so for now I'm using it regardless.
declare module "_stream_wrap" {
    import * as net from 'net';
    import * as streams from 'stream';

    class SocketWrapper extends net.Socket {
        constructor(stream: streams.Duplex);
        stream?: streams.Duplex & Partial<net.Socket>;
    }

    export = SocketWrapper;
}

declare module "http" {
    // Two missing methods from the official types:
    export function validateHeaderName(name: string): void;
    export function validateHeaderValue(name: string, value: unknown): void;
}

declare module "http2" {
    import * as net from 'net';

    class Http2Session {
        // session.socket is cleared before error handling kicks in. That's annoying,
        // so we manually preserve the socket elsewhere to work around it.
        initialSocket?: net.Socket;
    }

    class ServerHttp2Stream {
        // Treated the same as net.Socket, when we unwrap them in our combo server:
        __lastHopEncrypted?: net.Socket['__lastHopEncrypted'];
        __lastHopConnectAddress?: net.Socket['__lastHopConnectAddress'];
        __timingInfo?: net.Socket['__timingInfo'];
    }
}

declare class AggregateError extends Error {
    errors: Error[]
}
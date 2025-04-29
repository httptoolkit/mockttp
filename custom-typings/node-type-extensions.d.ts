// There's a few places where we attach extra data to some node objects during
// connection setup etc, to better track data & handle issues:

declare module "net" {
    import * as net from 'net';
    import * as stream from 'stream';

    interface Socket {
        // Normally only defined on TLSSocket, but useful to explicitly include here
        // Undefined on plain HTTP, 'true' on TLSSocket.
        encrypted?: boolean;

        // Internal reference to the parent socket, available on TLS sockets
        _parent?: Socket;

        // Internal reference to the underlying stream, available on _stream_wrap
        stream?: stream.Duplex & Partial<net.Socket>;
    }
}

declare module "tls" {
    import * as stream from 'stream';
    import * as net from 'net';

    interface TLSSocket {
        // This is a real field that actually exists - unclear why it's not
        // in the type definitions.
        servername?: string;

        _handle?: { // Internal, used for monkeypatching & error tracking
            oncertcb?: (info: any) => any;
            _parentWrap?: { // SocketWrapper
                stream?: stream.Duplex & Partial<net.Socket>
            };
        }
    }
}

declare module "http" {
    // Two missing methods from the official types:
    export function validateHeaderName(name: string): void;
    export function validateHeaderValue(name: string, value: unknown): void;
}

declare class AggregateError extends Error {
    errors: Error[]
}
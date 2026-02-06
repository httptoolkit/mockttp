// There's a few places where we attach extra data to some node objects during
// connection setup etc, to better track data & handle issues:

import * as stream from 'stream';
import * as net from 'net';

declare module "net" {
    interface Socket {
        // Normally only defined on TLSSocket, but useful to explicitly include here
        // Undefined on plain HTTP, 'true' on TLSSocket.
        encrypted?: boolean;

        // Internal reference to the parent socket, available on TLS sockets
        _parent?: net.Socket;

        // Internal reference to the underlying stream, available on _stream_wrap
        stream?: stream.Duplex & Partial<net.Socket>;
    }
}

declare module "tls" {
    interface TLSSocket {
        // Internal handle, used for monkeypatching & error tracking
        _handle?: {
            oncertcb?: (info: any) => any;
            _parentWrap?: { // SocketWrapper
                stream?: stream.Duplex & Partial<net.Socket>
            };
        }
    }
}

declare module "http" {
    export function validateHeaderName(name: string): void;
    export function validateHeaderValue(name: string, value: unknown): void;
}

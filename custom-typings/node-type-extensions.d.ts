// There's a few places where we attach extra data to some node objects during
// connection setup etc, to better track data & handle issues:

declare module "net" {
    interface Socket {
        // Have we CONNECT'd this socket to an upstream server? Defined if so.
        // Value tells you whether it started talking TLS or not afterwards.
        // If we somehow CONNECT repeatedly, this shows the state for the last time.
        upstreamEncryption?: boolean;

        // Normally only defined on TLSSocket, but useful to explicitly include here
        // Undefined on plain HTTP, 'true' on TLSSocket.
        encrypted?: boolean;

        // If there's a client error being sent, we track the corresponding packet
        // data on the socket, so that when it fires repeatedly we can combine them
        // into a single response & error event.
        clientErrorInProgress?: { rawPacket?: Buffer; }

        // Data that was peeked by httpolyglot, and thereby probably lost from the
        // HTTP parser errors, but which might be useful for debugging later
        __httpPeekedData?: Buffer;
    }
}

declare module "tls" {
    interface TLSSocket {
        // This is a real field that actually exists - unclear why it's not
        // in the type definitions.
        servername?: string;

        // We cache the initially set remote address on sockets, because it's cleared
        // before the TLS error callback is called, exactly when we want to read it.
        initialRemoteAddress?: string;

        // Marker used to detect whether client errors should be reported as TLS issues
        // (RST during handshake) or as subsequent client issues (RST during request)
        tlsSetupCompleted?: true;
    }
}
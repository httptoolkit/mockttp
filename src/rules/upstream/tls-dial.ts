import * as tls from 'tls';
import type { Writable } from 'stream';
import { CustomError } from '@httptoolkit/util';

import { awaitReady } from './await-ready';

export interface TlsDialOptions extends tls.ConnectionOptions {
    host: string;
    port: number;
    // Passed through to the TCP connection, though Node's TLS typings omit it:
    family: number | undefined;
    keyLogStream: Writable | undefined;
    onSession: (session: Buffer) => void;
}

/**
 * Open a TLS connection, resolving once the handshake completes, at which point the ALPN
 * result is known.
 */
export async function dialTls(
    { keyLogStream, onSession, ...connectOptions }: TlsDialOptions,
    signal: AbortSignal
): Promise<tls.TLSSocket> {
    signal.throwIfAborted();

    const socket = tls.connect(connectOptions);
    if (keyLogStream) socket.on('keylog', (line) => keyLogStream.write(line));
    socket.on('session', onSession);

    await awaitReady(socket, 'secureConnect', signal, () => new CustomError(
        'Upstream connection closed during the TLS handshake',
        { code: 'ECONNRESET' }
    ));
    return socket;
}

import { Buffer } from 'buffer';
import * as net from 'net';

import * as _ from 'lodash';

import { resetOrDestroy } from '../util/socket-util';
import { SocketMetadata } from '../util/socket-extensions';
import { getSocketMetadata } from '../util/socket-metadata';

export interface SocksServerOptions {
    /**
     * An array of authentication methods to be used for incoming SOCKS5
     * connections, in preference order. This defaults to `['no-auth']`.
     *
     * If `no-auth` is not included, all SOCKS4 connections will be
     * rejected (as they do not support authentication).
     *
     * The supported methods are:
     * - `no-auth`: Standard no-authentication-required method (0x00)
     * - `custom-metadata`: Custom method (0xDA), which doesn't authenticate
     *   but allows the client to send 2-byte-length-prefixed arbitrary JSON
     *   metadata to the server, which will be associated with all
     *   requests sent on this connection. The server will respond with
     *   0x05 0x00 for 'success' after the metadata is received, or
     *   0x05 0x01 for a general failure, or 0x05 0xDA plus a 2-byte-length-prefixed
     *   JSON error with a `message` field in other cases. The only currently
     *   exposed metadata is the `tags` field, if provided here. The `mockttpParams`
     *   field in this metadata is reserved for future use.
     * - `user-password-metadata`: Use standard username/password authentication
     *   method (0x02) to smuggle metadata - this does not really authenticate the
     *   user. The username must be `metadata` and the password
     *   must be a JSON object of up to 255 chars in total. All other usernames
     *   & passwords will be rejected. This metadata is used just like
     *   `custom-metadata` but this is compatible with existing SOCKS clients.
     *   This is still less preferable due to possible client confusion and
     *   the 255 character limit.
     */
    authMethods?: Array<keyof typeof AUTH_METHODS>;
}

export type SocksTcpAddress =
    | { type: 'hostname', hostname: string; port: number }
    | { type: 'ipv4', ip: string; port: number }
    | { type: 'ipv6', ip: string; port: number };

interface SocksServer extends net.Server {
    on(event: 'socks-tcp-connect', cb: (socket: net.Socket, address: SocksTcpAddress) => void): this;
    // Need to include all other net events we might want to use, or we lose the overload types:
    on(event: 'connection', listener: (socket: net.Socket) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
}

const AUTH_METHODS = {
    'no-auth': {
        id: 0x0,
        handler: handleNoAuth
    },
    'user-password-metadata': {
        id: 0x2,
        handler: handleUsernamePasswordMetadata
    },
    'custom-metadata': {
        id: 0xDA,
        handler: handleCustomMetadata
    }
} as const;

const AUTH_METHOD_KEYS = Object.keys(AUTH_METHODS) as Array<keyof typeof AUTH_METHODS>;

export function buildSocksServer(options: SocksServerOptions): SocksServer {
    const authMethods = options.authMethods ?? ['no-auth'];
    if (authMethods.length === 0) throw new Error('At least one SOCKS auth method must be specified');
    if (authMethods.some(method => !AUTH_METHOD_KEYS.includes(method))) {
        throw new Error(`Invalid SOCKS auth method specified. Supported methods are: ${AUTH_METHOD_KEYS.join(', ')}`);
    }

    return net.createServer(handleSocksConnect);


    async function handleSocksConnect(this: net.Server, socket: net.Socket) {
        const server = this;
        // Until we pass this socket onwards, we handle (and drop) any errors on it:
        socket.on('error', ignoreError);

        try {
            const firstByte = await readBytes(socket, 1);;
            const version = firstByte[0];
            if (version === 0x04) {
                return handleSocksV4(socket, (address: SocksTcpAddress) => {
                    socket.removeListener('error', ignoreError);
                    server.emit('socks-tcp-connect', socket, address);
                });
            } else if (version === 0x05) {
                return handleSocksV5(socket, (address: SocksTcpAddress) => {
                    socket.removeListener('error', ignoreError);
                    server.emit('socks-tcp-connect', socket, address);
                });
            } else {
                // Should never happen, since this is sniffed by Httpolyglot, but just in case:
                return resetOrDestroy(socket);
            }
        } catch (err) {
            // We log but otherwise ignore failures, e.g. if the client closes the
            // connection after sending just half a message.
            console.warn(`Failed to process SOCKS connection`, err);
            socket.destroy();
        }
    }

    async function handleSocksV4(socket: net.Socket, cb: (address: SocksTcpAddress) => void) {
        const buffer = await readBytes(socket, 7); // N.b version already read

        if (!authMethods.includes('no-auth')) {
            // We only support no-auth for now, so reject anything else
            return writeS4Rejection(socket);
        }

        const command = buffer[0];
        if (command !== 0x01) {
            // Only CONNECT is supported, reject anything else
            return writeS4Rejection(socket);
        }

        const port = buffer.readUInt16BE(1);
        const ip = buffer.subarray(3, 7).join('.');

        await readUntilNullByte(socket); // Read (and ignore) the user id

        if (ip.startsWith('0.0.0')) {
            // SOCKSv4a - the hostname will be sent (null-terminated) after the user id:
            const domain = await readUntilNullByte(socket);

            socket.write(Buffer.from([
                0x00,
                0x5A, // Success
                // Omit the bound address & port here. It doesn't make sense for
                // our use case, and clients generally shouldn't need this info.
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]));

            cb({
                type: 'hostname',
                hostname: domain.toString('utf8'),
                port
            });
        } else {
            // SOCKSv4 - we have an IPv4 address and we're good to go:
            socket.write(Buffer.from([
                0x00,
                0x5A, // Success
                // Omit the bound address & port here. It doesn't make sense for
                // our use case, and clients generally shouldn't need this info.
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]));

            cb({
                type: 'ipv4',
                ip: ip,
                port
            });
        }
    }

    async function handleSocksV5(socket: net.Socket, cb: (address: SocksTcpAddress) => void) {
        const buffer = await readBytes(socket, 1); // N.b version already read
        const authMethodsCount = buffer[0];

        const clientMethods = await readBytes(socket, authMethodsCount);
        const selectedAuthMethodId = authMethods.find(methodKey =>
            clientMethods.includes(AUTH_METHODS[methodKey].id)
        );

        if (selectedAuthMethodId === undefined) {
            // Reject any connections that don't match our supported auth methods:
            return socket.end(Buffer.from([
                0x05, // Version
                0xFF, // No acceptable auth methods
            ]));
        }

        const authMethod = AUTH_METHODS[selectedAuthMethodId];

        // Confirm the selected auth method:
        socket.write(Buffer.from([
            0x05, // Version
            authMethod.id
        ]));

        try {
            const success = await authMethod.handler(socket);
            if (!success) return;
        } catch (err) {
            console.warn(`SOCKS auth failed`, err);

            // Not actually totally clear what to return for an unknown error like this
            // but this should always make it clear that we're done in any case:
            return socket.end(Buffer.from([
                0x05,
                0x01 // General failure
            ]));
        }

        // Ok - we're authenticated, now negotiate the connection itself:

        const [
            version,
            command,
            _reserved,
            addressType
        ] = await readBytes(socket, 4);
        if (version !== 0x05) {
            // Should never happen, but just in case
            return writeS5ConnFailure(socket, 0x01); // General error
        }

        if (command !== 0x01) {
            // Only CONNECT is supported for now, reject anything else
            return writeS5ConnFailure(socket, 0x07); // General error
        }

        let address: SocksTcpAddress;

        if (addressType === 0x1) {
            const addressData = await readBytes(socket, 6);
            const ip = addressData.subarray(0, 4).join('.');
            const port = addressData.readUInt16BE(4);
            address = { type: 'ipv4', ip, port };
        } else if (addressType === 0x3) {
            const nameLength = await readBytes(socket, 1);
            const nameAndPortData = await readBytes(socket, nameLength[0] + 2);
            const name = nameAndPortData.subarray(0, nameLength[0]).toString('utf8');
            const port = nameAndPortData.readUInt16BE(nameLength[0]);
            address = { type: 'hostname', hostname: name, port };
        } else if (addressType === 0x4) {
            const addressData = await readBytes(socket, 18);
            const ip = addressData.subarray(0, 16).join(':');
            const port = addressData.readUInt16BE(16);
            address = { type: 'ipv6', ip, port };
        } else {
            return writeS5ConnFailure(socket, 0x08); // Unsupported address type
        }

        socket.write(Buffer.from([
            0x05, // Version
            0x00, // Success
            0x00, // Reserved
            0x01, // IPv4 bind address
            0x00, 0x00, 0x00, 0x00, // Blank bind address
            0x00, 0x00 // Blank bind port
        ]));

        cb(address);
    }
}

async function handleNoAuth() {
    return true;
}

async function handleCustomMetadata(socket: net.Socket) {
    const length = (await readBytes(socket, 2)).readUint16BE();
    const metadata = await readBytes(socket, length);
    const metadataString = metadata.toString('utf8');

    try {
        socket[SocketMetadata] = getSocketMetadata(socket[SocketMetadata], metadataString);
    } catch (e) {
        const errorData = Buffer.from(JSON.stringify({ message: 'Invalid JSON' }));
        const errorResponse = Buffer.alloc(4 + errorData.byteLength);
        errorResponse.writeUInt8(0x05, 0);
        errorResponse.writeUInt8(0xDA, 1);
        errorResponse.writeUInt16BE(errorData.byteLength, 2);
        errorData.copy(errorResponse, 4);
        socket.end(errorResponse);
        return false;
    }

    socket.write(Buffer.from([
        0x05, // Version
        0x00 // Success
    ]));

    return true;
}

async function handleUsernamePasswordMetadata(socket: net.Socket) {
    const versionAndLength = await readBytes(socket, 2);
    const usernameLength = versionAndLength.readUint8(1);
    const username = await readBytes(socket, usernameLength);
    const passwordLength = await readBytes(socket, 1);
    const password = await readBytes(socket, passwordLength[0]);

    if (username.toString('utf8') !== 'metadata') {
        socket.end(Buffer.from([
            0x05,
            0x01 // Generic rejection
        ]));
        return false;
    }

    try {
        socket[SocketMetadata] = getSocketMetadata(socket[SocketMetadata], password);
    } catch (e) {
        socket.end(Buffer.from([
            0x05,
            0x02 // Rejected (with a different error code to distinguish this case)
        ]));
        return false;
    }

    socket.write(Buffer.from([
        0x05, // Version
        0x00 // Success
    ]));

    return true;
}

async function readBytes(socket: net.Socket, length?: number | undefined): Promise<Buffer> {
    const buffer = socket.read(length);
    if (buffer === null) {
        return new Promise((resolve, reject) => {
            socket.once('readable', () => resolve(readBytes(socket, length)));
            socket.once('close', () => reject(new Error('Socket closed')));
            socket.once('error', reject);
        });
    } else if (length !== undefined && buffer.byteLength != length) {
        throw new Error(`Socket closed before we received ${length} bytes`);
    }

    return buffer;
}

async function readUntilNullByte(socket: net.Socket) {
    let buffers: Buffer[] = [];
    while (true) {
        const data = await readBytes(socket);

        const endOfIdIndex = data.indexOf(0x00);
        if (endOfIdIndex !== -1) {
            const remainingData = data.subarray(endOfIdIndex + 1);
            if (remainingData.length > 0) socket.unshift(remainingData);
            buffers.push(data.subarray(0, endOfIdIndex));
            break;
        } else {
            buffers.push(data);
        }
    }

    return Buffer.concat(buffers);
}

const writeS4Rejection = (socket: net.Socket) => {
    socket.end(Buffer.from([
        0x00,
        0x5B, // Generic rejection
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]));
};

const writeS5ConnFailure = (socket: net.Socket, errorCode: number) => {
    socket.end(Buffer.from([
        0x05, // Version
        errorCode, // Failure code
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // Blank bind address
    ]));
};

function ignoreError() {}
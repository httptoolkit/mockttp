import * as net from 'net';
import { resetOrDestroy } from '../util/socket-util';

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

export function buildSocksServer(): SocksServer {
    return net.createServer(handleSocksConnect);
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

function onError() {}

async function handleSocksConnect(this: net.Server, socket: net.Socket) {
    const server = this;
    // Until we pass this socket onwards, we handle (and drop) any errors on it:
    socket.on('error', onError);

    try {
        const firstByte = await readBytes(socket, 1);;
        const version = firstByte[0];
        if (version === 0x04) {
            return handleSocksV4(socket, (address: SocksTcpAddress) => {
                socket.removeListener('error', onError);
                server.emit('socks-tcp-connect', socket, address);
            });
        } else if (version === 0x05) {
            return handleSocksV5(socket, (address: SocksTcpAddress) => {
                socket.removeListener('error', onError);
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
    const command = buffer[0];
    if (command !== 0x01) {
        // Only CONNECT is supported, reject anything else
        return socket.end(Buffer.from([
            0x00,
            0x5B, // Rejected
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ]));
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

const writeS5ConnFailure = (socket: net.Socket, errorCode: number) => {
    socket.end(Buffer.from([
        0x05, // Version
        errorCode, // Failure code
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // Blank bind address
    ]));
};

async function handleSocksV5(socket: net.Socket, cb: (address: SocksTcpAddress) => void) {
    const buffer = await readBytes(socket, 1); // N.b version already read
    const authMethodsCount = buffer[0];

    const methods = await readBytes(socket, authMethodsCount);
    if (!methods.includes(0x00)) {
        // We only support no-auth for now, so reject anything else
        return socket.end(Buffer.from([
            0x05, // Version
            0xFF, // No acceptable auth methods
        ]));
    }

    // Send the no-auth acceptance response
    socket.write(Buffer.from([
        0x05, // Version
        0x00 // No auth
    ]));

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
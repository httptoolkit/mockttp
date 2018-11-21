import * as net from 'net';

// Grab the first byte of a stream
// Note that this isn't a great abstraction: you might
// need to manually resume() the stream afterwards.
export async function peekFirstByte(socket: net.Socket): Promise<number> {
    return new Promise<number>((resolve) => {
        socket.once('data', (data) => {
            socket.pause();
            socket.unshift(data);
            resolve(data[0]);
        });
    });
}

export function mightBeTLSHandshake(byte: number) {
    return byte === 22;
}
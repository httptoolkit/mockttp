declare module 'websocket-stream' {
    import * as net from 'net';
    import { Duplex } from "stream";

    function connectWebSocketStream(socket: net.Socket, option?: { objectMode?: boolean }): Duplex;
    function connectWebSocketStream(url: string, option?: { objectMode?: boolean }): Duplex;

    export = connectWebSocketStream;
}
declare module 'websocket-stream' {
    import { Duplex } from "stream";

    function connectWebSocketStream(socket: WebSocket, option?: { objectMode?: boolean }): Duplex;
    function connectWebSocketStream(url: string, option?: { objectMode?: boolean }): Duplex;

    export = connectWebSocketStream;
}
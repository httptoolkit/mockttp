declare module 'websocket-stream' {
    import { Duplex } from "stream";

    interface WebsocketOptions {
        objectMode?: boolean;
        headers?: { [key: string]: string }
    }

    function connectWebSocketStream(socket: WebSocket, options?: WebsocketOptions): Duplex;
    function connectWebSocketStream(url: string, options?: WebsocketOptions): Duplex;

    export = connectWebSocketStream;
}
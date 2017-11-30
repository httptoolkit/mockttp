declare module 'httpolyglot' {
    import * as net from 'net';
    import * as http from 'http';
    import * as https from "https";

    export function createServer(
        options: https.ServerOptions,
        callback?: (req: http.IncomingMessage, res: http.ServerResponse) => void
    ): net.Server;
}
declare module 'cors-gate' {
    import * as express from 'express';

    interface Options {
        origin: string;
        strict?: boolean;
        allowSafe?: boolean;
    }

    function corsGate(options: Options): express.RequestHandler;

    export = corsGate;
}
// Taken directly from https://github.com/types/npm-body-parser/blob/master/index.d.ts
// TODO: Move those definitions to DT, so they go to NPM, then depend on them directly

declare module "body-parser" {
    import {IncomingMessage, ServerResponse} from "http";

    /**
     * Options common for all parsers
     */
    export interface ParserOptions {
        /**
         * if deflated bodies will be inflated. (default: true)
         */
        inflate?: boolean;
        /**
         * maximum request body size. (default: '100kb')
         */
        limit?: number | string;
        /**
         * request content-type to parse, passed directly to the type-is library. (default: 'json')
         */
        type?: string | ((req: IncomingMessage) => boolean);
        /**
         * function to verify body content, the parsing can be aborted by throwing an error.
         */
        verify?: (req: IncomingMessage, res: ServerResponse, buf: Buffer, encoding: string) => void;
    }
    export interface Parsed {
        body: any;
    }

    export interface JsonParserOptions extends ParserOptions {
        /**
         * only parse objects and arrays. (default: true)
         */
        strict?: boolean;
        /**
         * passed to JSON.parse().
         */
        reviver?: (key: string, value: any) => any;
    }
    export function json(options?: JsonParserOptions): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;
    /**
     * You can use this in your parameter typing for `req`:
     *
     *     app.get('/whatever', bodyParser.json(), (req: Request & ParsedAsJson, res: Response) => {
     *         // req.body is now recognized as any
     *     });
     */
    export interface ParsedAsJson extends Parsed {}

    export interface RawParserOptions extends ParserOptions { }
    export function raw(options?: RawParserOptions): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;
    /**
     * You can use this in your parameter typing for `req`:
     *
     *     app.get('/whatever', bodyParser.json(), (req: Request & ParsedRaw, res: Response) => {
     *         // req.body is now recognized as Buffer
     *     });
     */
    export interface ParsedRaw extends Parsed {
        body: Buffer;
    }

    export interface TextParserOptions extends ParserOptions {
        /**
         * the default charset to parse as, if not specified in content-type. (default: 'utf-8')
         */
        defaultCharset?: string;
    }
    export function text(options?: TextParserOptions): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;
    /**
     * You can use this in your parameter typing for `req`:
     *
     *     app.get('/whatever', bodyParser.text(), (req: Request & ParsedAsText, res: Response) => {
     *         // req.body is now recognized as a string
     *     });
     */
    export interface ParsedAsText {
        body: string;
    }

    export interface UrlencodedParserOptions {
        /**
         * parse extended syntax with the qs module.
         */
        extended?: boolean;

        /**
         * controls the maximum number of parameters that are allowed in the URL-encoded data.
         * If a request contains more parameters than this value, a 413 will be returned to the client. Defaults to 1000.
         */
        parameterLimit?: number;
    }
    export function urlencoded(options?: UrlencodedParserOptions): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;
    /**
     * You can use this in your parameter typing for `req`:
     *
     *     app.get('/whatever', bodyParser.text(), (req: Request & ParsedAsText, res: Response) => {
     *         // req.body is now recognized as any
     *     });
     */
    export interface ParsedAsUrlencoded extends Parsed {}
}

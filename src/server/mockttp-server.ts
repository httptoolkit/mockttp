/**
 * @module Mockttp
 */

import net = require("net");
import url = require("url");
import tls = require("tls");
import http = require("http");
import http2 = require("http2");
import { EventEmitter } from "events";
import portfinder = require("portfinder");
import connect = require("connect");
import uuid = require('uuid/v4');
import cors = require("cors");
import now = require("performance-now");
import _ = require("lodash");

import {
    InitiatedRequest,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    TlsRequest,
    ClientError,
    TimingEvents,
    ParsedBody
} from "../types";
import { CAOptions } from '../util/tls';
import { DestroyableServer } from "../util/destroyable-server";
import { Mockttp, AbstractMockttp, MockttpOptions, PortRange } from "../mockttp";
import { RequestRule, RequestRuleData } from "../rules/requests/request-rule";
import { ServerMockedEndpoint } from "./mocked-endpoint";
import { createComboServer } from "./http-combo-server";
import { filter } from "../util/promise";

import {
    parseRequestBody,
    waitForCompletedRequest,
    trackResponse,
    waitForCompletedResponse,
    isAbsoluteUrl,
    buildInitiatedRequest,
    buildAbortedRequest,
    tryToParseHttp,
    buildBodyReader,
    getPathFromAbsoluteUrl
} from "../util/request-utils";
import { AbortError } from "../rules/requests/request-handlers";
import { WebSocketRuleData, WebSocketRule } from "../rules/websockets/websocket-rule";
import { PassThroughWebSocketHandler, WebSocketHandler } from "../rules/websockets/websocket-handlers";

type ExtendedRawRequest = (http.IncomingMessage | http2.Http2ServerRequest) & {
    protocol?: string;
    body?: ParsedBody;
    path?: string;
};

/**
 * A in-process Mockttp implementation. This starts servers on the local machine in the
 * current process, and exposes methods to directly manage them.
 *
 * This class does not work in browsers, as it expects to be able to start HTTP servers.
 */
export default class MockttpServer extends AbstractMockttp implements Mockttp {

    private requestRules: RequestRule[] = [];
    private webSocketRules: WebSocketRule[] = [];

    private httpsOptions: CAOptions | undefined;
    private isHttp2Enabled: true | false | 'fallback';
    private maxBodySize: number;

    private app: connect.Server;
    private server: DestroyableServer | undefined;

    private eventEmitter: EventEmitter;

    private readonly initialDebugSetting: boolean;

    private readonly defaultWsHandler!: WebSocketHandler;

    constructor(options: MockttpOptions = {}) {
        super(options);

        this.initialDebugSetting = this.debug;

        this.httpsOptions = options.https;
        this.isHttp2Enabled = options.http2 ?? 'fallback';
        this.maxBodySize = options.maxBodySize ?? Infinity;
        this.eventEmitter = new EventEmitter();

        this.defaultWsHandler = new PassThroughWebSocketHandler({
            // Support the old (now deprecated) websocket certificate whitelist for default
            // proxying only. Manually added rules get configured individually.
            ignoreHostCertificateErrors: this.ignoreWebsocketHostCertificateErrors
        });

        this.app = connect();

        if (this.corsOptions) {
            if (this.debug) console.log('Enabling CORS');

            const corsOptions = this.corsOptions === true
                ? { methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }
                : this.corsOptions;

            this.app.use(cors(corsOptions) as connect.HandleFunction);
        }

        this.app.use(this.handleRequest.bind(this));
    }

    async start(portParam: number | PortRange = { startPort: 8000, endPort: 65535 }): Promise<void> {
        const port = _.isNumber(portParam)
            ? portParam
            : await portfinder.getPortPromise({
                port: portParam.startPort,
                stopPort: portParam.endPort
            });

        if (this.debug) console.log(`Starting mock server on port ${port}`);

        this.server = await createComboServer({
            debug: this.debug,
            https: this.httpsOptions,
            http2: this.isHttp2Enabled,
        }, this.app, this.announceTlsErrorAsync.bind(this));

        this.server!.listen(port);

        // Handle & report client request errors
        this.server!.on('clientError', this.handleInvalidHttp1Request.bind(this));
        this.server!.on('sessionError', this.handleInvalidHttp2Request.bind(this));

        // Track the socket of HTTP/2 sessions, for error reporting later:
        this.server!.on('session', (session) => {
            session.on('connect', (session: http2.Http2Session, socket: net.Socket) => {
                session.initialSocket = socket;
            });
        });

        this.server!.on('upgrade', this.handleWebSocket.bind(this));

        return new Promise<void>((resolve, reject) => {
            this.server!.on('listening', resolve);
            this.server!.on('error', (e: any) => {
                // Although we try to pick a free port, we may have race conditions, if something else
                // takes the same port at the same time. If you haven't explicitly picked a port, and
                // we do have a collision, simply try again.
                if (e.code === 'EADDRINUSE' && !_.isNumber(portParam)) {
                    if (this.debug) console.log('Address in use, retrying...');

                    // Destroy just in case there is something that needs cleanup here. Catch because most
                    // of the time this will error with 'Server is not running'.
                    this.server!.destroy().catch(() => {});
                    resolve(this.start());
                } else {
                    reject(e);
                }
            });
        });
    }

    async stop(): Promise<void> {
        if (this.debug) console.log(`Stopping server at ${this.url}`);

        if (this.server) await this.server.destroy();

        this.reset();
    }

    enableDebug() {
        this.debug = true;
    }

    reset() {
        this.requestRules.forEach(r => r.dispose());
        this.requestRules = [];
        this.webSocketRules.forEach(r => r.dispose());
        this.webSocketRules = [];

        this.debug = this.initialDebugSetting;
    }

    private get address() {
        if (!this.server) throw new Error('Cannot get address before server is started');

        return (this.server.address() as net.AddressInfo)
    }

    get url(): string {
        if (!this.server) throw new Error('Cannot get url before server is started');

        if (this.httpsOptions) {
            return "https://localhost:" + this.port;
        } else {
            return "http://localhost:" + this.port;
        }
    }

    get port(): number {
        if (!this.server) throw new Error('Cannot get port before server is started');

        return this.address.port;
    }

    public setRequestRules = (...ruleData: RequestRuleData[]): Promise<ServerMockedEndpoint[]> => {
        this.requestRules.forEach(r => r.dispose());
        this.requestRules = ruleData.map((ruleDatum) => new RequestRule(ruleDatum));
        return Promise.resolve(this.requestRules.map(r => new ServerMockedEndpoint(r)));
    }

    public addRequestRules = (...ruleData: RequestRuleData[]): Promise<ServerMockedEndpoint[]> => {
        return Promise.resolve(ruleData.map((ruleDatum) => {
            const rule = new RequestRule(ruleDatum);
            this.requestRules.push(rule);
            return new ServerMockedEndpoint(rule);
        }));
    }

    public setWebSocketRules = (...ruleData: WebSocketRuleData[]): Promise<ServerMockedEndpoint[]> => {
        this.webSocketRules.forEach(r => r.dispose());
        this.webSocketRules = ruleData.map((ruleDatum) => new WebSocketRule(ruleDatum));
        return Promise.resolve(this.webSocketRules.map(r => new ServerMockedEndpoint(r)));
    }

    public addWebSocketRules = (...ruleData: WebSocketRuleData[]): Promise<ServerMockedEndpoint[]> => {
        return Promise.resolve(ruleData.map((ruleDatum) => {
            const rule = new WebSocketRule(ruleDatum);
            this.webSocketRules.push(rule);
            return new ServerMockedEndpoint(rule);
        }));
    }

    public async getMockedEndpoints(): Promise<ServerMockedEndpoint[]> {
        return [
            ...this.requestRules.map(r => new ServerMockedEndpoint(r)),
            ...this.webSocketRules.map(r => new ServerMockedEndpoint(r))
        ];
    }

    public async getPendingEndpoints() {
        const withPendingPromises = (await this.getMockedEndpoints())
            .map(async (endpoint) => ({
                endpoint,
                isPending: await endpoint.isPending()
            }));

        const withPending = await Promise.all(withPendingPromises);
        return withPending.filter(wp => wp.isPending).map(wp => wp.endpoint);
    }

    public on(event: 'request-initiated', callback: (req: InitiatedRequest) => void): Promise<void>;
    public on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;
    public on(event: 'abort', callback: (req: InitiatedRequest) => void): Promise<void>;
    public on(event: 'tls-client-error', callback: (req: TlsRequest) => void): Promise<void>;
    public on(event: 'tlsClientError', callback: (req: TlsRequest) => void): Promise<void>;
    public on(event: 'client-error', callback: (error: ClientError) => void): Promise<void>;
    public on(event: string, callback: (...args: any[]) => void): Promise<void> {
        this.eventEmitter.on(event, callback);
        return Promise.resolve();
    }

    private announceInitialRequestAsync(request: OngoingRequest) {
        setImmediate(() => {
            const initiatedReq = buildInitiatedRequest(request);
            this.eventEmitter.emit('request-initiated', Object.assign(
                initiatedReq,
                {
                    timingEvents: _.clone(initiatedReq.timingEvents),
                    tags: _.clone(initiatedReq.tags)
                }
            ));
        });
    }

    private announceCompletedRequestAsync(request: OngoingRequest) {
        setImmediate(() => {
            waitForCompletedRequest(request)
            .then((completedReq: CompletedRequest) => {
                this.eventEmitter.emit('request', Object.assign(
                    completedReq,
                    {
                        timingEvents: _.clone(completedReq.timingEvents),
                        tags: _.clone(completedReq.tags)
                    }
                ));
            })
            .catch(console.error);
        });
    }

    private announceResponseAsync(response: OngoingResponse) {
        setImmediate(() => {
            waitForCompletedResponse(response)
            .then((res: CompletedResponse) => {
                this.eventEmitter.emit('response', Object.assign(res, {
                    timingEvents: _.clone(res.timingEvents),
                    tags: _.clone(res.tags)
                }));
            })
            .catch(console.error);
        });
    }

    private async announceAbortAsync(request: OngoingRequest) {
        setImmediate(() => {
            const req = buildAbortedRequest(request);
            this.eventEmitter.emit('abort', Object.assign(req, {
                timingEvents: _.clone(req.timingEvents),
                tags: _.clone(req.tags)
            }));
        });
    }

    private async announceTlsErrorAsync(socket: net.Socket, request: TlsRequest) {
        // Ignore errors after TLS is setup, those are client errors
        if (socket instanceof tls.TLSSocket && socket.tlsSetupCompleted) return;

        setImmediate(() => {
            // We can get falsey but set hostname values - drop them
            if (!request.hostname) delete request.hostname;
            if (this.debug) console.warn(`TLS client error: ${JSON.stringify(request)}`);
            this.eventEmitter.emit('tls-client-error', request);
            this.eventEmitter.emit('tlsClientError', request);
        });
    }

    private async announceClientErrorAsync(socket: net.Socket | undefined, error: ClientError) {
        // Ignore errors before TLS is setup, those are TLS errors
        if (
            socket instanceof tls.TLSSocket &&
            !socket.tlsSetupCompleted &&
            error.errorCode !== 'ERR_HTTP2_ERROR' // Initial HTTP/2 errors are considered post-TLS
        ) return;

        setImmediate(() => {
            if (this.debug) console.warn(`Client error: ${JSON.stringify(error)}`);
            this.eventEmitter.emit('client-error', error);
        });
    }

    private preprocessRequest(req: ExtendedRawRequest): OngoingRequest {
        parseRequestBody(req, { maxSize: this.maxBodySize });

        // Make req.url always absolute, if it isn't already, using the host header.
        // It might not be if this is a direct request, or if it's being transparently proxied.
        if (!isAbsoluteUrl(req.url!)) {
            req.protocol = req.headers[':scheme'] as string ||
                (req.socket.lastHopEncrypted ? 'https' : 'http');
            req.path = req.url;

            const host = req.headers[':authority'] || req.headers['host'];
            const absoluteUrl = `${req.protocol}://${host}${req.path}`;

            if (!req.headers[':path']) {
                req.url = new url.URL(absoluteUrl).toString();
            } else {
                // Node's HTTP/2 compat logic maps .url to headers[':path']. We want them to
                // diverge: .url should always be absolute, while :path may stay relative,
                // so we override the built-in getter & setter:
                Object.defineProperty(req, 'url', {
                    value: new url.URL(absoluteUrl).toString()
                });
            }
        } else {
            req.protocol = req.url!.split('://', 1)[0];
            req.path = getPathFromAbsoluteUrl(req.url!);
        }

        const id = uuid();
        const timingEvents = { startTime: Date.now(), startTimestamp: now() };
        const tags: string[] = [];

        return Object.assign(req, {
            id,
            timingEvents,
            tags
        }) as OngoingRequest;
    }

    private async handleRequest(rawRequest: ExtendedRawRequest, rawResponse: http.ServerResponse) {
        if (this.debug) console.log(`Handling request for ${rawRequest.url}`);

        const request = this.preprocessRequest(rawRequest);

        let result: 'responded' | 'aborted' | null = null;
        const abort = () => {
            if (result === null) {
                result = 'aborted';
                request.timingEvents.abortedTimestamp = now();
                this.announceAbortAsync(request);
            }
        }
        request.once('aborted', abort);
        this.announceInitialRequestAsync(request);

        const response = trackResponse(
            rawResponse,
            request.timingEvents,
            request.tags,
            { maxSize: this.maxBodySize }
        );
        response.id = request.id;
        response.on('error', (error) => {
            console.log('Response error:', this.debug ? error : error.message);
            abort();
        });

        let nextRulePromise = this.findMatchingRule(this.requestRules, request);

        // Async: once we know what the next rule is, ping a request event
        nextRulePromise
            .then((rule) => rule ? rule.id : undefined)
            .catch(() => undefined)
            .then((ruleId) => {
                request.matchedRuleId = ruleId;
                this.announceCompletedRequestAsync(request);
            });

        try {
            let nextRule = await nextRulePromise;
            if (nextRule) {
                if (this.debug) console.log(`Request matched rule: ${nextRule.explain()}`);
                await nextRule.handle(request, response, this.recordTraffic);
            } else {
                await this.sendUnmatchedRequestError(request, response);
            }
            result = result || 'responded';
        } catch (e) {
            if (e instanceof AbortError) {
                abort();

                if (this.debug) {
                    console.error("Failed to handle request due to abort:", e);
                }
            } else {
                console.error("Failed to handle request:", this.debug ? e : e.message);

                // Do whatever we can to tell the client we broke
                try {
                    response.writeHead(e.statusCode || 500, e.statusMessage || 'Server error');
                } catch (e) {}

                try {
                    response.end(e.toString());
                    result = result || 'responded';
                } catch (e) {
                    abort();
                }
            }
        }

        if (result === 'responded') {
            this.announceResponseAsync(response);
        }
    }

    async handleWebSocket(rawRequest: ExtendedRawRequest, socket: net.Socket, head: Buffer) {
        if (this.debug) console.log(`Handling websocket for ${rawRequest.url}`);

        const request = this.preprocessRequest(rawRequest);

        socket.on('error', (error) => {
            console.log('Response error:', this.debug ? error : error.message);
            socket.destroy();
        });

        let nextRulePromise = this.findMatchingRule(this.webSocketRules, request);

        try {
            let nextRule = await nextRulePromise;
            if (nextRule) {
                if (this.debug) console.log(`Websocket matched rule: ${nextRule.explain()}`);
                await nextRule.handle(request, socket, head, this.recordTraffic);
            } else {
                // Unmatched requests get passed through untouched automatically. This exists for
                // historical/backward-compat reasons, to match the initial WS implementation, and
                // will probably be removed to match handleRequest in future.
                await this.defaultWsHandler.handle(request, socket, head);
            }
        } catch (e) {
            if (e instanceof AbortError) {
                if (this.debug) {
                    console.error("Failed to handle websocket due to abort:", e);
                }
            } else {
                console.error("Failed to handle websocket:", this.debug ? e : e.message);
                this.sendWebSocketErrorResponse(socket, e);
            }
        }
    }

    private async findMatchingRule<R extends WebSocketRule | RequestRule>(
        rules: Array<R>,
        request: OngoingRequest
    ): Promise<R | undefined> {
        // Start all rules matching immediately
        const rulesMatches = rules.map((r) => ({ rule: r, match: r.matches(request) }));

        // Evaluate the matches one by one, and immediately use the first
        for (let { rule, match } of rulesMatches) {
            if (await match && rule.isComplete() === false) {
                // The first matching incomplete rule we find is the one we should use
                return rule;
            }
        }

        // There are no incomplete & matching rules! One last option: if the last matching rule is
        // maybe-incomplete (i.e. default completion status but has seen >0 requests) then it should
        // match anyway. This allows us to add rules and have the last repeat indefinitely.
        const lastMatchingRule = _.last(await filter(rulesMatches, m => m.match))?.rule;
        if (!lastMatchingRule || lastMatchingRule.isComplete()) return undefined;
        // Otherwise, must be a rule with isComplete === null, i.e. no specific completion check:
        else return lastMatchingRule;
    }

    private async getUnmatchedRequestExplanation(request: OngoingRequest) {
        let requestExplanation = await this.explainRequest(request);
        if (this.debug) console.warn(`Unmatched request received: ${requestExplanation}`);

        return `No rules were found matching this request.");
This request was: ${requestExplanation}

${(this.requestRules.length > 0 || this.webSocketRules.length > 0)
    ? `The configured rules are:
${this.requestRules.map((rule) => rule.explain()).join("\n")}
${this.webSocketRules.map((rule) => rule.explain()).join("\n")}
`
    : "There are no rules configured."
}
${await this.suggestRule(request)}`
    }

    private async sendUnmatchedRequestError(request: OngoingRequest, response: http.ServerResponse) {
        response.setHeader('Content-Type', 'text/plain');
        response.writeHead(503, "Request for unmocked endpoint");
        response.end(await this.getUnmatchedRequestExplanation(request));
    }

    private async sendWebSocketErrorResponse(socket: net.Socket, error: Error) {
        if (socket.writable) {
            socket.end(
                'HTTP/1.1 500 Internal Server Error\r\n' +
                '\r\n' +
                error.message
            );
        }

        socket.destroy(error);
    }

    private async explainRequest(request: OngoingRequest): Promise<string> {
        let msg = `${request.method} request to ${request.url}`;

        let bodyText = await request.body.asText();
        if (bodyText) msg += ` with body \`${bodyText}\``;

        if (!_.isEmpty(request.headers)) {
            msg += ` with headers:\n${JSON.stringify(request.headers, null, 2)}`;
        }

        return msg;
    }

    private async suggestRule(request: OngoingRequest): Promise<string> {
        if (!this.suggestChanges) return '';

        let msg = "You can fix this by adding a rule to match this request, for example:\n"

        msg += `mockServer.${request.method.toLowerCase()}("${request.path}")`;

        const contentType = request.headers['content-type'];
        let isFormRequest = !!contentType && contentType.indexOf("application/x-www-form-urlencoded") > -1;
        let formBody = await request.body.asFormData().catch(() => undefined);

        if (isFormRequest && !!formBody) {
            msg += `.withForm(${JSON.stringify(formBody)})`;
        }

        msg += '.thenReply(200, "your response");';

        return msg;
    }

    // Called on server clientError, e.g. if the client disconnects during initial
    // request data, or sends totally invalid gibberish. Only called for HTTP/1.1 errors.
    private handleInvalidHttp1Request(
        error: Error & { code?: string, rawPacket?: Buffer },
        socket: net.Socket
    ) {
        if (socket.clientErrorInProgress) {
            // For subsequent errors on the same socket, accumulate packet data (linked to the socket)
            // so that the error (probably delayed until next tick) has it all to work with
            const previousPacket = socket.clientErrorInProgress.rawPacket;
            const newPacket = error.rawPacket;
            if (!newPacket || newPacket === previousPacket) return;

            if (previousPacket && previousPacket.length > 0) {
                if (previousPacket.equals(newPacket.slice(0, previousPacket.length))) {
                    // This is the same data, but more - update the client error data
                    socket.clientErrorInProgress.rawPacket = newPacket;
                } else {
                    // This is different data for the same socket, probably an overflow, append it
                    socket.clientErrorInProgress.rawPacket = Buffer.concat([
                        previousPacket,
                        newPacket
                    ]);
                }
            } else {
                // The first error had no data, we have data - use our data
                socket.clientErrorInProgress!.rawPacket = newPacket;
            }
            return;
        }

        // We can get multiple errors for the same socket in rapid succession as the parser works,
        // so we store the initial buffer, wait a tick, and then reply/report the accumulated
        // buffer from all errors together.
        socket.clientErrorInProgress = {
            // We use HTTP peeked data to catch extra data the parser sees due to httpolyglot peeking,
            // but which gets lost from the raw packet. If that data alone causes an error though
            // (e.g. Q as first char) then this packet data does get thrown! Eugh. In that case,
            // we need to avoid using both by accident, so we use just the non-peeked data instead.
            rawPacket: error.rawPacket === socket.__httpPeekedData
                ? undefined
                : error.rawPacket
        };

        setImmediate(async () => {
            const errorCode = error.code;
            const isHeaderOverflow = errorCode === "HPE_HEADER_OVERFLOW";

            const commonParams = {
                id: uuid(),
                tags: [`client-error:${error.code || 'UNKNOWN'}`],
                timingEvents: { startTime: Date.now(), startTimestamp: now() } as TimingEvents
            };

            // Initially _httpMessage is undefined, until at least one request has been parsed.
            // Later it's set to the current ServerResponse, and then null when the socket is
            // detached, but never back to undefined. Avoids issues with using old peeked data
            // on subsequent requests within keep-alive connections.
            const isFirstRequest = (socket as any)._httpMessage === undefined;

            // HTTPolyglot's byte-peeking can sometimes lose the initial byte from the parser's
            // exposed buffer. If that's happened, we need to get it back:
            const rawPacket = Buffer.concat(
                [
                    isFirstRequest && socket.__httpPeekedData,
                    socket.clientErrorInProgress?.rawPacket
                ].filter((data) => !!data) as Buffer[]
            );

            // For packets where we get more than just httpolyglot-peeked data, guess-parse them:
            const parsedRequest = rawPacket.byteLength > 1
                ? tryToParseHttp(rawPacket, socket)
                : {};

            if (isHeaderOverflow) commonParams.tags.push('header-overflow');

            const request: ClientError['request'] = {
                ...commonParams,
                httpVersion: parsedRequest.httpVersion,
                method: parsedRequest.method,
                protocol: parsedRequest.protocol,
                url: parsedRequest.url,
                path: parsedRequest.path,
                headers: parsedRequest.headers || {}
            };

            let response: ClientError['response'];

            if (socket.writable) {
                response = {
                    ...commonParams,
                    headers: { 'Connection': 'close' },
                    statusCode:
                        isHeaderOverflow
                            ? 431
                        : 400,
                    statusMessage:
                        isHeaderOverflow
                            ? "Request Header Fields Too Large"
                        : "Bad Request",
                    body: buildBodyReader(Buffer.from([]), {})
                };

                const responseBuffer = Buffer.from(
                    `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
                    "Connection: close\r\n\r\n",
                    'ascii'
                );

                // Wait for the write to complete before we destroy() below
                await new Promise((resolve) => socket.write(responseBuffer, resolve));

                commonParams.timingEvents.headersSentTimestamp = now();
                commonParams.timingEvents.responseSentTimestamp = now();
            } else {
                response = 'aborted';
                commonParams.timingEvents.abortedTimestamp = now();
            }

            this.announceClientErrorAsync(socket, { errorCode, request, response });

            socket.destroy(error);
        });
    }

    // Handle HTTP/2 client errors. This is a work in progress, but usefully reports
    // some of the most obvious cases.
    private handleInvalidHttp2Request(
        error: Error & { code?: string, errno?: number },
        session: http2.Http2Session
    ) {
        // Unlike with HTTP/1.1, we have no control of the actual handling of
        // the error here, so this is just a matter of announcing the error to subscribers.

        const socket = session.initialSocket;
        const isTLS = socket instanceof tls.TLSSocket;

        const isBadPreface = (error.errno === -903);

        this.announceClientErrorAsync(session.initialSocket, {
            errorCode: error.code,
            request: {
                id: uuid(),
                tags: [
                    `client-error:${error.code || 'UNKNOWN'}`,
                    ...(isBadPreface ? ['client-error:bad-preface'] : [])
                ],
                httpVersion: '2',

                // Best guesses:
                timingEvents: { startTime: Date.now(), startTimestamp: now() } as TimingEvents,
                protocol: isTLS ? "https" : "http",
                url: isTLS ? `https://${
                    (socket as tls.TLSSocket).servername // Use the hostname from SNI
                }/` : undefined,

                // Unknowable:
                path: undefined,
                headers: {}
            },
            response: 'aborted' // These h2 errors get no app-level response, just a shutdown.
        });
    }
}
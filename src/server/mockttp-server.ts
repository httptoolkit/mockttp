import _ = require("lodash");
import net = require("net");
import url = require("url");
import tls = require("tls");
import http = require("http");
import http2 = require("http2");
import { EventEmitter } from "events";
import portfinder = require("portfinder");
import connect = require("connect");
import { v4 as uuid } from "uuid";
import cors = require("cors");
import now = require("performance-now");
import WebSocket = require("ws");
import { Mutex } from 'async-mutex';

import {
    InitiatedRequest,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    TlsHandshakeFailure,
    ClientError,
    TimingEvents,
    OngoingBody,
    WebSocketMessage,
    WebSocketClose,
    TlsPassthroughEvent,
    RuleEvent,
    RawTrailers
} from "../types";
import { DestroyableServer } from "destroyable-server";
import {
    Mockttp,
    AbstractMockttp,
    MockttpOptions,
    MockttpHttpsOptions,
    PortRange
} from "../mockttp";
import { RequestRule, RequestRuleData } from "../rules/requests/request-rule";
import { ServerMockedEndpoint } from "./mocked-endpoint";
import { createComboServer } from "./http-combo-server";
import { filter } from "../util/promise";
import { Mutable } from "../util/type-utils";
import { ErrorLike, isErrorLike } from "../util/error";
import { makePropertyWritable } from "../util/util";

import { isAbsoluteUrl, getPathFromAbsoluteUrl } from "../util/url";
import { buildSocketEventData, isSocketLoop, resetOrDestroy } from "../util/socket-util";
import {
    parseRequestBody,
    waitForCompletedRequest,
    trackResponse,
    waitForCompletedResponse,
    buildInitiatedRequest,
    tryToParseHttpRequest,
    buildBodyReader,
    parseRawHttpResponse
} from "../util/request-utils";
import { asBuffer } from "../util/buffer-utils";
import {
    pairFlatRawHeaders,
    rawHeadersToObject
} from "../util/header-utils";
import { AbortError } from "../rules/requests/request-handlers";
import { WebSocketRuleData, WebSocketRule } from "../rules/websockets/websocket-rule";
import { RejectWebSocketHandler, WebSocketHandler } from "../rules/websockets/websocket-handlers";

type ExtendedRawRequest = (http.IncomingMessage | http2.Http2ServerRequest) & {
    protocol?: string;
    body?: OngoingBody;
    path?: string;
};

const serverPortCheckMutex = new Mutex();

/**
 * A in-process Mockttp implementation. This starts servers on the local machine in the
 * current process, and exposes methods to directly manage them.
 *
 * This class does not work in browsers, as it expects to be able to start HTTP servers.
 */
export class MockttpServer extends AbstractMockttp implements Mockttp {

    private requestRuleSets: { [priority: number]: RequestRule[] } = {};
    private webSocketRuleSets: { [priority: number]: WebSocketRule[] } = {};

    private httpsOptions: MockttpHttpsOptions | undefined;
    private isHttp2Enabled: true | false | 'fallback';
    private maxBodySize: number;

    private app: connect.Server;
    private server: DestroyableServer<net.Server> | undefined;

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

        this.defaultWsHandler = new RejectWebSocketHandler(503, "Request for unmocked endpoint");

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
        this.server = await createComboServer({
            debug: this.debug,
            https: this.httpsOptions,
            http2: this.isHttp2Enabled,
        }, this.app, this.announceTlsErrorAsync.bind(this), this.passthroughSocket.bind(this));

        // We use a mutex here to avoid contention on ports with parallel setup
        await serverPortCheckMutex.runExclusive(async () => {
            const port = _.isNumber(portParam)
                ? portParam
                : await portfinder.getPortPromise({
                    port: portParam.startPort,
                    stopPort: portParam.endPort
                });

            if (this.debug) console.log(`Starting mock server on port ${port}`);
            this.server!.listen(port);
        });

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
        Object.values(this.requestRuleSets).flat().forEach(r => r.dispose());
        this.requestRuleSets = [];

        Object.values(this.webSocketRuleSets).flat().forEach(r => r.dispose());
        this.webSocketRuleSets = [];

        this.debug = this.initialDebugSetting;

        this.eventEmitter.removeAllListeners();
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

    private addToRuleSets<R extends RequestRule | WebSocketRule>(
        ruleSets: { [priority: number]: R[] },
        rule: R
    ) {
        ruleSets[rule.priority] ??= [];
        ruleSets[rule.priority].push(rule);
    }

    public setRequestRules = (...ruleData: RequestRuleData[]): Promise<ServerMockedEndpoint[]> => {
        Object.values(this.requestRuleSets).flat().forEach(r => r.dispose());

        const rules = ruleData.map((ruleDatum) => new RequestRule(ruleDatum));
        this.requestRuleSets = _.groupBy(rules, r => r.priority);

        return Promise.resolve(rules.map(r => new ServerMockedEndpoint(r)));
    }

    public addRequestRules = (...ruleData: RequestRuleData[]): Promise<ServerMockedEndpoint[]> => {
        return Promise.resolve(ruleData.map((ruleDatum) => {
            const rule = new RequestRule(ruleDatum);
            this.addToRuleSets(this.requestRuleSets, rule);
            return new ServerMockedEndpoint(rule);
        }));
    }

    public setWebSocketRules = (...ruleData: WebSocketRuleData[]): Promise<ServerMockedEndpoint[]> => {
        Object.values(this.webSocketRuleSets).flat().forEach(r => r.dispose());

        const rules = ruleData.map((ruleDatum) => new WebSocketRule(ruleDatum));
        this.webSocketRuleSets = _.groupBy(rules, r => r.priority);

        return Promise.resolve(rules.map(r => new ServerMockedEndpoint(r)));
    }

    public addWebSocketRules = (...ruleData: WebSocketRuleData[]): Promise<ServerMockedEndpoint[]> => {
        return Promise.resolve(ruleData.map((ruleDatum) => {
            const rule = new WebSocketRule(ruleDatum);
            (this.webSocketRuleSets[rule.priority] ??= []).push(rule);
            return new ServerMockedEndpoint(rule);
        }));
    }

    public async getMockedEndpoints(): Promise<ServerMockedEndpoint[]> {
        return [
            ...Object.values(this.requestRuleSets).flatMap(rules => rules.map(r => new ServerMockedEndpoint(r))),
            ...Object.values(this.webSocketRuleSets).flatMap(rules => rules.map(r => new ServerMockedEndpoint(r)))
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

    public async getRuleParameterKeys() {
        return []; // Local servers never have rule parameters defined
    }

    public on(event: 'request-initiated', callback: (req: InitiatedRequest) => void): Promise<void>;
    public on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;
    public on(event: 'abort', callback: (req: InitiatedRequest) => void): Promise<void>;
    public on(event: 'websocket-request', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: 'websocket-accepted', callback: (req: CompletedResponse) => void): Promise<void>;
    public on(event: 'websocket-message-received', callback: (req: WebSocketMessage) => void): Promise<void>;
    public on(event: 'websocket-message-sent', callback: (req: WebSocketMessage) => void): Promise<void>;
    public on(event: 'websocket-close', callback: (close: WebSocketClose) => void): Promise<void>;
    public on(event: 'tls-passthrough-opened', callback: (req: TlsPassthroughEvent) => void): Promise<void>;
    public on(event: 'tls-passthrough-closed', callback: (req: TlsPassthroughEvent) => void): Promise<void>;
    public on(event: 'tls-client-error', callback: (req: TlsHandshakeFailure) => void): Promise<void>;
    public on(event: 'client-error', callback: (error: ClientError) => void): Promise<void>;
    public on<T = unknown>(event: 'rule-event', callback: (event: RuleEvent<T>) => void): Promise<void>;
    public on(event: string, callback: (...args: any[]) => void): Promise<void> {
        this.eventEmitter.on(event, callback);
        return Promise.resolve();
    }

    private announceInitialRequestAsync(request: OngoingRequest) {
        if (this.eventEmitter.listenerCount('request-initiated') === 0) return;

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
        if (this.eventEmitter.listenerCount('request') === 0) return;

        waitForCompletedRequest(request)
        .then((completedReq: CompletedRequest) => {
            setImmediate(() => {
                this.eventEmitter.emit('request', Object.assign(
                    completedReq,
                    {
                        timingEvents: _.clone(completedReq.timingEvents),
                        tags: _.clone(completedReq.tags)
                    }
                ));
            });
        })
        .catch(console.error);
    }

    private announceResponseAsync(response: OngoingResponse | CompletedResponse) {
        if (this.eventEmitter.listenerCount('response') === 0) return;

        waitForCompletedResponse(response)
        .then((res: CompletedResponse) => {
            setImmediate(() => {
                this.eventEmitter.emit('response', Object.assign(res, {
                    timingEvents: _.clone(res.timingEvents),
                    tags: _.clone(res.tags)
                }));
            });
        })
        .catch(console.error);
    }

    private announceWebSocketRequestAsync(request: OngoingRequest) {
        if (this.eventEmitter.listenerCount('websocket-request') === 0) return;

        waitForCompletedRequest(request)
        .then((completedReq: CompletedRequest) => {
            setImmediate(() => {
                this.eventEmitter.emit('websocket-request', Object.assign(completedReq, {
                    timingEvents: _.clone(completedReq.timingEvents),
                    tags: _.clone(completedReq.tags)
                }));
            });
        })
        .catch(console.error);
    }

    private announceWebSocketUpgradeAsync(response: CompletedResponse) {
        if (this.eventEmitter.listenerCount('websocket-accepted') === 0) return;

        setImmediate(() => {
            this.eventEmitter.emit('websocket-accepted', {
                ...response,
                timingEvents: _.clone(response.timingEvents),
                tags: _.clone(response.tags)
            });
        });
    }

    private announceWebSocketMessageAsync(
        request: OngoingRequest,
        direction: 'sent' | 'received',
        content: Buffer,
        isBinary: boolean
    ) {
        const eventName = `websocket-message-${direction}`;
        if (this.eventEmitter.listenerCount(eventName) === 0) return;

        setImmediate(() => {
            this.eventEmitter.emit(eventName, {
                streamId: request.id,

                direction,
                content,
                isBinary,

                eventTimestamp: now(),
                timingEvents: request.timingEvents,
                tags: request.tags
            } as WebSocketMessage);
        });
    }

    private announceWebSocketCloseAsync(
        request: OngoingRequest,
        closeCode: number | undefined,
        closeReason?: string
    ) {
        if (this.eventEmitter.listenerCount('websocket-close') === 0) return;

        setImmediate(() => {
            this.eventEmitter.emit('websocket-close', {
                streamId: request.id,

                closeCode,
                closeReason,

                timingEvents: request.timingEvents,
                tags: request.tags
            } as WebSocketClose);
        });
    }

    // Hook the request and socket to announce all WebSocket events after the initial request:
    private trackWebSocketEvents(request: OngoingRequest, socket: net.Socket) {
        const originalWrite = socket._write;
        const originalWriteV = socket._writev;

        // Hook the socket to capture our upgrade response:
        let data = Buffer.from([]);
        socket._writev = undefined;
        socket._write = function (): any {
            data = Buffer.concat([data, asBuffer(arguments[0])]);
            return originalWrite.apply(this, arguments as any);
        };

        let upgradeCompleted = false;

        socket.once('close', () => {
            if (upgradeCompleted) return;

            if (data.length) {
                request.timingEvents.responseSentTimestamp = now();

                const httpResponse = parseRawHttpResponse(data, request);
                this.announceResponseAsync(httpResponse);
            } else {
                // Connect closed during upgrade, before we responded:
                request.timingEvents.abortedTimestamp = now();
                this.announceAbortAsync(request);
            }
        });

        socket.once('ws-upgrade', (ws: WebSocket) => {
            upgradeCompleted = true;

            // Undo our write hook setup:
            socket._write = originalWrite;
            socket._writev = originalWriteV;

            request.timingEvents.wsAcceptedTimestamp = now();

            const httpResponse = parseRawHttpResponse(data, request);
            this.announceWebSocketUpgradeAsync(httpResponse);

            ws.on('message', (data: Buffer, isBinary) => {
                this.announceWebSocketMessageAsync(request, 'received', data, isBinary);
            });

            // Wrap ws.send() to report all sent data:
            const _send = ws.send;
            const self = this;
            ws.send = function (data: any, options: any): any {
                const isBinary = options.binary
                    ?? typeof data !== 'string';

                _send.apply(this, arguments as any);
                self.announceWebSocketMessageAsync(request, 'sent', asBuffer(data), isBinary);
            };

            ws.on('close', (closeCode, closeReason) => {
                if (closeCode === 1006) {
                    // Not a clean close!
                    request.timingEvents.abortedTimestamp = now();
                    this.announceAbortAsync(request);
                } else {
                    request.timingEvents.wsClosedTimestamp = now();

                    this.announceWebSocketCloseAsync(
                        request,
                        closeCode === 1005
                            ? undefined // Clean close, but with a close frame with no status
                            : closeCode,
                        closeReason.toString('utf8')
                    );
                }
            });
        });
    }

    private async announceAbortAsync(request: OngoingRequest, abortError?: ErrorLike) {
        setImmediate(() => {
            const req = buildInitiatedRequest(request);
            this.eventEmitter.emit('abort', Object.assign(req, {
                timingEvents: _.clone(req.timingEvents),
                tags: _.clone(req.tags),
                error: abortError ? {
                    name: abortError.name,
                    code: abortError.code,
                    message: abortError.message,
                    stack: abortError.stack
                } : undefined
            }));
        });
    }

    private async announceTlsErrorAsync(socket: net.Socket, request: TlsHandshakeFailure) {
        // Ignore errors after TLS is setup, those are client errors
        if (socket instanceof tls.TLSSocket && socket.tlsSetupCompleted) return;

        setImmediate(() => {
            // We can get falsey but set hostname values - drop them
            if (!request.hostname) delete request.hostname;
            if (this.debug) console.warn(`TLS client error: ${JSON.stringify(request)}`);
            this.eventEmitter.emit('tls-client-error', request);
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

    private async announceRuleEventAsync(requestId: string, ruleId: string, eventType: string, eventData: unknown) {
        setImmediate(() => {
            this.eventEmitter.emit('rule-event', {
                requestId,
                ruleId,
                eventType,
                eventData
            });
        });
    }

    private preprocessRequest(req: ExtendedRawRequest, type: 'request' | 'websocket'): OngoingRequest {
        parseRequestBody(req, { maxSize: this.maxBodySize });

        // Make req.url always absolute, if it isn't already, using the host header.
        // It might not be if this is a direct request, or if it's being transparently proxied.
        if (!isAbsoluteUrl(req.url!)) {
            req.protocol = req.headers[':scheme'] as string ||
                (req.socket.__lastHopEncrypted ? 'https' : 'http');
            req.path = req.url;

            const host = req.headers[':authority'] || req.headers['host'];
            const absoluteUrl = `${req.protocol}://${host}${req.path}`;

            if (!req.headers[':path']) {
                (req as Mutable<ExtendedRawRequest>).url = new url.URL(absoluteUrl).toString();
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

        if (type === 'websocket') {
            req.protocol = req.protocol === 'https'
                ? 'wss'
                : 'ws';

            // Transform the protocol in req.url too:
            Object.defineProperty(req, 'url', {
                value: req.url!.replace(/^http/, 'ws')
            });
        }

        const id = uuid();
        const tags: string[] = [];

        const timingEvents: TimingEvents = {
            startTime: Date.now(),
            startTimestamp: now()
        };

        req.on('end', () => {
            timingEvents.bodyReceivedTimestamp ||= now();
        });

        const rawHeaders = pairFlatRawHeaders(req.rawHeaders);
        const headers = rawHeadersToObject(rawHeaders);

        // Not writable for HTTP/2:
        makePropertyWritable(req, 'headers');
        makePropertyWritable(req, 'rawHeaders');

        let rawTrailers: RawTrailers | undefined;
        Object.defineProperty(req, 'rawTrailers', {
            get: () => rawTrailers,
            set: (flatRawTrailers) => {
                rawTrailers = flatRawTrailers
                    ? pairFlatRawHeaders(flatRawTrailers)
                    : undefined;
            }
        });

        return Object.assign(req, {
            id,
            headers,
            rawHeaders,
            rawTrailers, // Just makes the type happy - really managed by property above
            remoteIpAddress: req.socket.remoteAddress,
            remotePort: req.socket.remotePort,
            timingEvents,
            tags
        }) as OngoingRequest;
    }

    private async handleRequest(rawRequest: ExtendedRawRequest, rawResponse: http.ServerResponse) {
        const request = this.preprocessRequest(rawRequest, 'request');
        if (this.debug) console.log(`Handling request for ${rawRequest.url}`);

        let result: 'responded' | 'aborted' | null = null;
        const abort = (error?: Error) => {
            if (result === null) {
                result = 'aborted';
                request.timingEvents.abortedTimestamp = now();
                this.announceAbortAsync(request, error);
            }
        }
        request.once('aborted', abort);
        // In Node 16+ we don't get an abort event in many cases, just closes, but we know
        // it's aborted because the response is closed with no other result being set.
        rawResponse.once('close', () => setImmediate(abort));
        request.once('error', (error) => setImmediate(() => abort(error)));

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
            abort(error);
        });

        try {
            let nextRulePromise = this.findMatchingRule(this.requestRuleSets, request);

            // Async: once we know what the next rule is, ping a request event
            nextRulePromise
                .then((rule) => rule ? rule.id : undefined)
                .catch(() => undefined)
                .then((ruleId) => {
                    request.matchedRuleId = ruleId;
                    this.announceCompletedRequestAsync(request);
                });

            let nextRule = await nextRulePromise;
            if (nextRule) {
                if (this.debug) console.log(`Request matched rule: ${nextRule.explain()}`);
                await nextRule.handle(request, response, {
                    record: this.recordTraffic,
                    emitEventCallback: (this.eventEmitter.listenerCount('rule-event') !== 0)
                        ? (type, event) => this.announceRuleEventAsync(request.id, nextRule!.id, type, event)
                        : undefined
                });
            } else {
                await this.sendUnmatchedRequestError(request, response);
            }
            result = result || 'responded';
        } catch (e) {
            if (e instanceof AbortError) {
                abort(e);

                if (this.debug) {
                    console.error("Failed to handle request due to abort:", e);
                }
            } else {
                console.error("Failed to handle request:",
                    this.debug
                        ? e
                        : (isErrorLike(e) && e.message) || e
                );

                // Do whatever we can to tell the client we broke
                try {
                    response.writeHead(
                        (isErrorLike(e) && e.statusCode) || 500,
                        (isErrorLike(e) && e.statusMessage) || 'Server error'
                    );
                } catch (e) {}

                try {
                    response.end((isErrorLike(e) && e.toString()) || e);
                    result = result || 'responded';
                } catch (e) {
                    abort(e as Error);
                }
            }
        }

        if (result === 'responded') {
            this.announceResponseAsync(response);
        }
    }

    private async handleWebSocket(rawRequest: ExtendedRawRequest, socket: net.Socket, head: Buffer) {
        if (this.debug) console.log(`Handling websocket for ${rawRequest.url}`);

        const request = this.preprocessRequest(rawRequest, 'websocket');

        socket.on('error', (error) => {
            console.log('Response error:', this.debug ? error : error.message);
            socket.destroy();
        });

        try {
            let nextRulePromise = this.findMatchingRule(this.webSocketRuleSets, request);

            // Async: once we know what the next rule is, ping a websocket-request event
            nextRulePromise
                .then((rule) => rule ? rule.id : undefined)
                .catch(() => undefined)
                .then((ruleId) => {
                    request.matchedRuleId = ruleId;
                    this.announceWebSocketRequestAsync(request);
                });

            this.trackWebSocketEvents(request, socket);

            let nextRule = await nextRulePromise;
            if (nextRule) {
                if (this.debug) console.log(`Websocket matched rule: ${nextRule.explain()}`);
                await nextRule.handle(request, socket, head, {
                    record: this.recordTraffic,
                    emitEventCallback: (this.eventEmitter.listenerCount('rule-event') !== 0)
                        ? (type, event) => this.announceRuleEventAsync(request.id, nextRule!.id, type, event)
                        : undefined
                });
            } else {
                // Unmatched requests get passed through untouched automatically. This exists for
                // historical/backward-compat reasons, to match the initial WS implementation, and
                // will probably be removed to match handleRequest in future.
                await this.defaultWsHandler.handle(
                    request as OngoingRequest & http.IncomingMessage,
                    socket,
                    head,
                    { emitEventCallback: (this.eventEmitter.listenerCount('rule-event') !== 0)
                        ? (type, event) => this.announceRuleEventAsync(request.id, nextRule!.id, type, event)
                        : undefined
                    }
                );
            }
        } catch (e) {
            if (e instanceof AbortError) {
                if (this.debug) {
                    console.error("Failed to handle websocket due to abort:", e);
                }
            } else {
                console.error("Failed to handle websocket:",
                    this.debug
                    ? e
                    : (isErrorLike(e) && e.message) || e
                );
                this.sendWebSocketErrorResponse(socket, e);
            }
        }
    }

    /**
     * To match rules, we find the first rule (by priority then by set order) which matches and which is
     * either not complete (has a completion check that's false) or which has no completion check defined
     * and is the last option at that priority (i.e. by the last option at each priority repeats indefinitely.
     *
     * We move down the priority list only when either no rules match at all, or when all matching rules
     * have explicit completion checks defined that are completed.
     */
    private async findMatchingRule<R extends WebSocketRule | RequestRule>(
        ruleSets: { [priority: number]: Array<R> },
        request: OngoingRequest
    ): Promise<R | undefined> {
        for (let ruleSet of Object.values(ruleSets).reverse()) { // Obj.values returns numeric keys in ascending order
            // Start all rules matching immediately
            const rulesMatches = ruleSet
                .filter((r) => r.isComplete() !== true) // Skip all rules that are definitely completed
                .map((r) => ({ rule: r, match: r.matches(request) }));

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
            if (!lastMatchingRule || lastMatchingRule.isComplete()) continue; // On to lower priority matches
            // Otherwise, must be a rule with isComplete === null, i.e. no specific completion check:
            else return lastMatchingRule;
        }

        return undefined; // There are zero valid matching rules at any priority, give up.
    }

    private async getUnmatchedRequestExplanation(request: OngoingRequest) {
        let requestExplanation = await this.explainRequest(request);
        if (this.debug) console.warn(`Unmatched request received: ${requestExplanation}`);

        const requestRules = Object.values(this.requestRuleSets).flat();
        const webSocketRules = Object.values(this.webSocketRuleSets).flat();

        return `No rules were found matching this request.
This request was: ${requestExplanation}

${(requestRules.length > 0 || webSocketRules.length > 0)
    ? `The configured rules are:
${requestRules.map((rule) => rule.explain()).join("\n")}
${webSocketRules.map((rule) => rule.explain()).join("\n")}
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

    private async sendWebSocketErrorResponse(socket: net.Socket, error: unknown) {
        if (socket.writable) {
            socket.end(
                'HTTP/1.1 500 Internal Server Error\r\n' +
                '\r\n' +
                (isErrorLike(error)
                    ? error.message ?? error.toString()
                    : ''
                )
            );
        }

        socket.destroy(error as Error);
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

        msg += `mockServer.for${_.startCase(request.method.toLowerCase())}("${request.path}")`;

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
            // we need to avoid using both by accident, so we use just the non-peeked data instead
            // if the initial data is _exactly_ identical.
            rawPacket: error.rawPacket
        };

        setImmediate(async () => {
            const errorCode = error.code;
            const isHeaderOverflow = errorCode === "HPE_HEADER_OVERFLOW";

            const commonParams = {
                id: uuid(),
                tags: [`client-error:${error.code || 'UNKNOWN'}`],
                timingEvents: { startTime: Date.now(), startTimestamp: now() } as TimingEvents
            };

            const rawPacket = socket.clientErrorInProgress?.rawPacket
                ?? Buffer.from([]);

            // For packets where we get more than just httpolyglot-peeked data, guess-parse them:
            const parsedRequest = rawPacket.byteLength > 1
                ? tryToParseHttpRequest(rawPacket, socket)
                : {};

            if (isHeaderOverflow) commonParams.tags.push('header-overflow');

            const request: ClientError['request'] = {
                ...commonParams,
                httpVersion: parsedRequest.httpVersion,
                method: parsedRequest.method,
                protocol: parsedRequest.protocol,
                url: parsedRequest.url,
                path: parsedRequest.path,
                headers: parsedRequest.headers || {},
                rawHeaders: parsedRequest.rawHeaders || [],
                remoteIpAddress: socket.remoteAddress,
                remotePort: socket.remotePort
            };

            let response: ClientError['response'];

            if (socket.writable) {
                response = {
                    ...commonParams,
                    headers: { 'connection': 'close' },
                    rawHeaders: [['Connection', 'close']],
                    trailers: {},
                    rawTrailers: [],
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
                timingEvents: { startTime: Date.now(), startTimestamp: now() },
                protocol: isTLS ? "https" : "http",
                url: isTLS ? `https://${
                    (socket as tls.TLSSocket).servername // Use the hostname from SNI
                }/` : undefined,

                // Unknowable:
                path: undefined,
                headers: {},
                rawHeaders: []
            },
            response: 'aborted' // These h2 errors get no app-level response, just a shutdown.
        });
    }

    private outgoingPassthroughSockets: Set<net.Socket> = new Set();

    private passthroughSocket(
        socket: net.Socket,
        host: string,
        port?: number
    ) {
        const targetPort = port || 443;

        if (isSocketLoop(this.outgoingPassthroughSockets, socket)) {
            // Hard to reproduce: loops can only happen if a) SNI triggers this (because tunnels
            // require a repeated client request at each step) and b) the hostname points back to
            // us, and c) we're running on the default port. Still good to guard against though.
            console.warn(`Socket bypass loop for ${host}:${targetPort}`);
            resetOrDestroy(socket);
            return;
        }

        if (socket.closed) return; // Nothing to do

        const eventData = buildSocketEventData(socket as any) as TlsPassthroughEvent;
        eventData.id = uuid();
        eventData.hostname = host;
        eventData.upstreamPort = targetPort;
        setImmediate(() => this.eventEmitter.emit('tls-passthrough-opened', eventData));

        const upstreamSocket = net.connect({ host, port: targetPort });

        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);

        socket.on('error', () => upstreamSocket.destroy());
        upstreamSocket.on('error', () => socket.destroy());
        upstreamSocket.on('close', () => socket.destroy());
        socket.on('close', () => {
            upstreamSocket.destroy();
            setImmediate(() => {
                this.eventEmitter.emit('tls-passthrough-closed', {
                    ...eventData,
                    timingEvents: {
                        ...eventData.timingEvents,
                        disconnectedTimestamp: now()
                    }
                });
            });
        });

        upstreamSocket.once('connect', () => this.outgoingPassthroughSockets.add(upstreamSocket));
        upstreamSocket.once('close', () => this.outgoingPassthroughSockets.delete(upstreamSocket));

        if (this.debug) console.log(`Passing through raw bypassed connection to ${host}:${targetPort}${
            !port ? ' (assumed port)' : ''
        }`);
    }
}
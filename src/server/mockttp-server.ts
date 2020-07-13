/**
 * @module Mockttp
 */

import net = require("net");
import url = require("url");
import tls = require("tls");
import http = require("http");
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
import { MockRule, MockRuleData } from "../rules/mock-rule";
import { MockedEndpoint } from "./mocked-endpoint";
import { createComboServer } from "./http-combo-server";
import { filter } from "../util/promise";

import {
    parseBody,
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
import { WebSocketHandler } from "./websocket-handler";
import { AbortError } from "../rules/handlers";

interface ExtendedRawRequest extends http.IncomingMessage {
    protocol?: string;
    body?: ParsedBody;
    path?: string;
}

/**
 * A in-process Mockttp implementation. This starts servers on the local machine in the
 * current process, and exposes methods to directly manage them.
 *
 * This class does not work in browsers, as it expects to be able to start HTTP servers.
 */
export default class MockttpServer extends AbstractMockttp implements Mockttp {
    private rules: MockRule[] = [];

    private httpsOptions: CAOptions | undefined;

    private app: connect.Server;
    private server: DestroyableServer | undefined;

    private eventEmitter: EventEmitter;

    private readonly initialDebugSetting: boolean;

    constructor(options: MockttpOptions = {}) {
        super(options);

        this.initialDebugSetting = this.debug;

        this.httpsOptions = options.https;
        this.eventEmitter = new EventEmitter();

        this.app = connect();

        if (this.corsOptions) {
            if (this.debug) console.log('Enabling CORS');

            const corsOptions = this.corsOptions === true
                ? { methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }
                : this.corsOptions;

            this.app.use(cors(corsOptions) as connect.HandleFunction);
        }

        this.app.use(parseBody);
        this.app.use((
            req: ExtendedRawRequest,
            _res: http.ServerResponse,
            next: () => void
        ) => {
            // Make req.url always absolute, if it isn't already, using the host header.
            // It might not be if this is a direct request, or if it's being transparently proxied.
            if (!isAbsoluteUrl(req.url!)) {
                req.protocol = (req.socket instanceof tls.TLSSocket) ? 'https' : 'http';
                req.path = req.url;
                req.url = new url.URL(req.url!, `${req.protocol}://${req.headers['host']}`).toString();
            } else {
                req.protocol = req.url!.split('://', 1)[0];
                req.path = getPathFromAbsoluteUrl(req.url!);
            }

            next();
        });
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
            https: this.httpsOptions
        }, this.app, this.announceTlsErrorAsync.bind(this));

        this.server!.listen(port);

        // Handle & report client request errors
        this.server!.on('clientError', this.handleInvalidHttp1Request.bind(this));
        this.server!.on('sessionError', this.handleInvalidHttp2Request.bind(this));

        // Handle websocket connections too (ignore for now, just forward on)
        const webSocketHander = new WebSocketHandler(this.debug);
        this.server!.on('upgrade', webSocketHander.handleUpgrade.bind(webSocketHander));

        return new Promise<void>((resolve, reject) => {
            this.server!.on('listening', resolve);
            this.server!.on('error', (e: any) => {
                // Although we try to pick a free port, we may have race conditions, if something else
                // takes the same port at the same time. If you haven't explicitly picked a port, and
                // we do have a collision, simply try again.
                if (e.code === 'EADDRINUSE' && !portParam) {
                    if (this.debug) console.log('Address in use, retrying...');

                    this.server!.destroy(); // Don't bother waiting for this, it can stop on its own time
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
        this.rules.forEach(r => r.dispose());
        this.rules = [];
        this.debug = this.initialDebugSetting;
    }

    get mockedEndpoints(): MockedEndpoint[] {
        return this.rules.map((rule) => new MockedEndpoint(rule));
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

    public setRules = (...ruleData: MockRuleData[]): Promise<MockedEndpoint[]> => {
        this.rules.forEach(r => r.dispose());
        this.rules = ruleData.map((ruleDatum) => new MockRule(ruleDatum));
        return Promise.resolve(this.rules.map(r => new MockedEndpoint(r)));
    }

    public addRules = (...ruleData: MockRuleData[]): Promise<MockedEndpoint[]> => {
        return Promise.resolve(ruleData.map((ruleDatum) => {
            const rule = new MockRule(ruleDatum);
            this.rules.push(rule);
            return new MockedEndpoint(rule);
        }));
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

    private async announceClientErrorAsync(socket: net.Socket, error: ClientError) {
        // Ignore errors before TLS is setup, those are TLS errors
        if (socket instanceof tls.TLSSocket && !socket.tlsSetupCompleted) return;

        setImmediate(() => {
            if (this.debug) console.warn(`Client error: ${JSON.stringify(error)}`);
            this.eventEmitter.emit('client-error', error);
        });
    }

    private async handleRequest(rawRequest: ExtendedRawRequest, rawResponse: http.ServerResponse) {
        if (this.debug) console.log(`Handling request for ${rawRequest.url}`);

        const timingEvents = { startTime: Date.now(), startTimestamp: now() };
        const tags: string[] = [];

        const response = trackResponse(rawResponse, timingEvents, tags);

        const id = uuid();

        const request = <OngoingRequest>Object.assign(rawRequest, {
            id: id,
            timingEvents,
            tags
        });
        response.id = id;

        this.announceInitialRequestAsync(request);

        let result: 'responded' | 'aborted' | null = null;
        const abort = () => {
            if (result === null) {
                result = 'aborted';
                request.timingEvents.abortedTimestamp = now();
                this.announceAbortAsync(request);
            }
        }
        request.once('aborted', abort);

        let nextRulePromise = filter(this.rules, (r) => r.matches(request))
            .then((matchingRules) =>
                matchingRules.filter((r) =>
                    !this.isComplete(r, matchingRules)
                )[0] as MockRule | undefined
            );

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
                if (this.debug) {
                    console.error("Failed to handle request:", e);
                } else {
                    console.error("Failed to handle request:", e.message);
                }

                // Make sure any errors here don't kill the process
                response.on('error', (e) => {});

                // Do whatever we can to tell the client we broke
                try { response.writeHead(e.statusCode || 500, e.statusMessage || 'Server error'); } catch (e) {}
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

    private isComplete = (rule: MockRule, matchingRules: MockRule[]) => {
        const isDefinitelyComplete = rule.isComplete();
        if (isDefinitelyComplete !== null) {
            return isDefinitelyComplete;
        } else if (matchingRules[matchingRules.length - 1] === rule) {
            return false;
        } else {
            return rule.requests.length !== 0;
        }
    }

    private async sendUnmatchedRequestError(request: OngoingRequest, response: http.ServerResponse) {
        let requestExplanation = await this.explainRequest(request);
        if (this.debug) console.warn(`Unmatched request received: ${requestExplanation}`);

        response.setHeader('Content-Type', 'text/plain');
        response.writeHead(503, "Request for unmocked endpoint");

        response.write("No rules were found matching this request.\n");
        response.write(`This request was: ${requestExplanation}\n\n`);

        if (this.rules.length > 0) {
            response.write("The configured rules are:\n");
            this.rules.forEach((rule) => response.write(rule.explain() + "\n"));
        } else {
            response.write("There are no rules configured.\n");
        }

        response.end(await this.suggestRule(request));
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
        error: Error & { code?: number },
        socket: net.Socket
    ) {
        // Unlike with HTTP/1.1, we have no control of the actual handling of
        // the error here, so this is just a matter of announcing the error to subscribers.

        // We only fire one error per socket, and we use the first we hear about.
        // Later errors are often "write after close" etc, not so useful.
        if (socket.clientErrorInProgress) return;
        socket.clientErrorInProgress = {};

        // Some hacky code to convert error codes into nicer names, which ignores any
        // SPDY/HTTP2 distinctions. We can improve this when we build error handling for real.
        const errorName = require(
            'spdy-transport/lib/spdy-transport/protocol/http2/constants'
        ).errorByCode[error.code!] || error.code;

        const isTLS = socket instanceof tls.TLSSocket;

        this.announceClientErrorAsync(socket, {
            errorCode: errorName,
            request: {
                id: uuid(),
                tags: [`client-error:${errorName || 'UNKNOWN'}`],
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
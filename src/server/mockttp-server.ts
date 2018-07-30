/**
 * @module Mockttp
 */

import net = require("net");
import http = require("http");
import https = require("https");
import EventEmitter = require("events");
import tls = require('tls');
import portfinder = require("portfinder");
import express = require("express");

import cors = require("cors");
import _ = require("lodash");

import { OngoingRequest, CompletedRequest, CompletedResponse, OngoingResponse } from "../types";
import { MockRuleData } from "../rules/mock-rule-types";
import { CAOptions, getCA } from '../util/tls';
import destroyable, { DestroyableServer } from "../util/destroyable-server";
import { Mockttp, AbstractMockttp, MockttpOptions } from "../mockttp";
import { MockRule } from "../rules/mock-rule";
import { filter } from "../util/promise";

import { MockedEndpoint } from "./mocked-endpoint";
import {
    parseBody,
    waitForCompletedRequest,
    trackResponse,
    waitForCompletedResponse,
} from "./request-utils";


/**
 * A in-process Mockttp implementation. This starts servers on the local machine in the
 * current process, and exposes methods to directly manage them.
 * 
 * This class does not work in browsers, as it expects to be able to start HTTP servers.
 */
export default class MockttpServer extends AbstractMockttp implements Mockttp {
    private rules: MockRule[] = [];

    private httpsOptions: CAOptions | undefined;

    private app: express.Application;
    private server: DestroyableServer | undefined;

    private eventEmitter: EventEmitter;

    constructor(options: MockttpOptions = {}) {
        super(options);

        this.httpsOptions = options.https;
        this.eventEmitter = new EventEmitter();

        this.app = express();

        if (this.cors) {
            if (this.debug) console.log('Enabling CORS');
            this.app.use(cors({
                methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
            }));
        }

        this.app.use(parseBody);
        this.app.use(this.handleRequest.bind(this));
    }

    async start(portParam?: number): Promise<void> {
        if (!_.isInteger(portParam) && !_.isUndefined(portParam)) {
            throw new Error(`Cannot start server with port ${portParam}. If passed, the port must be an integer`);
        }

        const port = (portParam || await new Promise<number>((resolve, reject) => {
            portfinder.getPort((err, port) => {
                if (err) reject(err);
                else resolve(port);
            });
        }));

        if (this.debug) console.log(`Starting mock server on port ${port}`);

        if (this.httpsOptions) {
            const ca = await getCA(this.httpsOptions);
            const defaultCert = ca.generateCertificate('localhost');

            this.server = destroyable(https.createServer({
                key: defaultCert.key,
                cert: defaultCert.cert,
                ca: [defaultCert.ca],
                // TODO: Fix DT's node types for this callback - Error should be Error|null
                SNICallback: (domain, cb: any) => {
                    if (this.debug) console.log(`Generating server certificate for ${domain}`);

                    const generatedCert = ca.generateCertificate(domain);
                    cb(null, tls.createSecureContext({
                        key: generatedCert.key,
                        cert: generatedCert.cert
                    }));
                }
            }, this.app).listen(port));

            this.server.addListener('connect', (req: http.IncomingMessage, socket: net.Socket) => {
                const [ targetHost, port ] = req.url!.split(':');

                if (this.debug) console.log(`Proxying connection for ${targetHost}, with HTTP CONNECT tunnel`);
                const generatedCert = ca.generateCertificate(targetHost);

                socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', () => {
                    let tlsSocket = new tls.TLSSocket(socket, {
                        isServer: true,
                        server: this.server,
                        secureContext: tls.createSecureContext(generatedCert)
                    });
                    tlsSocket.on('error', (e: Error) => {
                        if (this.debug) {
                            console.warn(`Error in proxy TLS connection:\n${e}`);
                        } else {
                            console.warn(`Error in proxy TLS connection: ${e.message}`);
                        }

                        // We can't recover from this - just try to close the underlying socket.
                        try { socket.destroy(); } catch (e) {}
                    });

                    // This is a little crazy, but only a little. We create a server to handle HTTP parsing etc, but
                    // never listen on any ports or anything, we just hand it a live socket. Setup is pretty cheap here
                    // (instantiate, sets up as event emitter, registers some events & properties, that's it), and
                    // this is the easiest way I can see to put targetHost into the URL, without reimplementing HTTP.
                    http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
                        req.url = `https://${targetHost}:${port}${req.url}`;
                        return this.app(<express.Request> req, <express.Response> res);
                    }).emit('connection', tlsSocket);
                });

                socket.on('error', (e: Error) => {
                    if (this.debug) {
                        console.warn(`Error in connection to HTTPS proxy:\n${e}`);
                    } else {
                        console.warn(`Error in connection to HTTPS proxy: ${e.message}`);
                    }

                    // We can't recover from this - just try to close the socket.
                    try { socket.destroy(); } catch (e) {}
                });
            });
        } else {
            this.server = destroyable(this.app.listen(port));
        }

        return new Promise<void>((resolve, reject) => {
            this.server!.on('listening', resolve);
            this.server!.on('error', (e: any) => {
                // Although we try to pick a free port, we may have race conditions, if something else
                // takes the same port at the same time. If you haven't explicitly picked a port, and
                // we do have a collision, simply try again.
                if (e.code === 'EADDRINUSE' && !portParam) {
                    if (this.debug) console.log('Address in use, retrying...');

                    this.server!.close(); // Don't bother waiting for this, it can stop on its own time
                    resolve(this.start());
                } else {
                    throw e;
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
        this.rules = [];
        this.debug = false;
    }

    get mockedEndpoints(): MockedEndpoint[] {
        return this.rules.map((rule) => new MockedEndpoint(rule));
    }

    get url(): string {
        if (!this.server) throw new Error('Cannot get url before server is started');

        if (this.httpsOptions) {
            return "https://localhost:" + this.server.address().port;
        } else {
            return "http://localhost:" + this.server.address().port;
        }
    }

    get port(): number {
        if (!this.server) throw new Error('Cannot get port before server is started');

        return this.server.address().port;
    }

    public addRule = (ruleData: MockRuleData): Promise<MockedEndpoint> => {
        const rule = new MockRule(ruleData);
        this.rules.push(rule);
        return Promise.resolve(new MockedEndpoint(rule));
    }

    public on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;
    public on(event: string, callback: Function): Promise<void> {
        this.eventEmitter.on(event, callback);
        return Promise.resolve();
    }

    private announceRequestAsync(request: OngoingRequest) {
        setImmediate(() => {
            waitForCompletedRequest(request)
            .then((req: CompletedRequest) => {
                this.eventEmitter.emit('request', req);
            })
            .catch(console.error);
        });
    }

    private announceResponseAsync(response: OngoingResponse) {
        setImmediate(() => {
            waitForCompletedResponse(response)
            .then((res: CompletedResponse) => {
                this.eventEmitter.emit('response', res);
            })
            .catch(console.error);
        });
    }

    private async handleRequest(request: OngoingRequest, rawResponse: express.Response) {
        if (this.debug) console.log(`Handling request for ${request.url}`);

        this.announceRequestAsync(request);
        const response = trackResponse(rawResponse);

        try {
            let matchingRules = await filter(this.rules, (r) => r.matches(request));
            let nextRule = matchingRules.filter((r) => !this.isComplete(r, matchingRules))[0];

            if (nextRule) {
                if (this.debug) console.log(`Request matched rule: ${nextRule.explain()}`);
                await nextRule.handleRequest(request, response);
            } else {
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
        } catch (e) {
            if (this.debug) {
                console.error("Failed to handle request:", e);
            } else {
                console.error("Failed to handle request:", e.message);
            }

            // Make sure any errors here don't kill the process
            response.on('error', (e) => {});

            // Do whatever we can to tell the client we broke
            try { response.writeHead(e.statusCode || 500, e.statusMessage || 'Server error'); } catch (e) {}
            try { response.end(e.toString()); } catch (e) {}
        }

        this.announceResponseAsync(response);
    }

    private isComplete = (rule: MockRule, matchingRules: MockRule[]) => {
        if (rule.isComplete) {
            return rule.isComplete();
        } else if (matchingRules[matchingRules.length - 1] === rule) {
            return false;
        } else {
            return rule.requests.length !== 0;
        }
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
        let msg = "You can fix this by adding a rule to match this request, for example:\n"

        msg += `mockServer.${request.method.toLowerCase()}("${request.path}")`;

        let isFormRequest = !!request.headers["content-type"] && request.headers["content-type"].indexOf("application/x-www-form-urlencoded") > -1;
        let formBody = await request.body.asFormData().catch(() => undefined);

        if (isFormRequest && !!formBody) {
            msg += `.withForm(${JSON.stringify(formBody)})`;
        }

        msg += '.thenReply(200, "your response");';

        return msg;
    }
}
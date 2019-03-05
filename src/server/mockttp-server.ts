/**
 * @module Mockttp
 */

import net = require("net");
import { EventEmitter } from "events";
import portfinder = require("portfinder");
import express = require("express");
import uuid = require('uuid/v4');
import cors = require("cors");
import _ = require("lodash");

import { OngoingRequest, CompletedRequest, CompletedResponse, OngoingResponse } from "../types";
import { MockRuleData } from "../rules/mock-rule-types";
import { CAOptions } from '../util/tls';
import { DestroyableServer } from "../util/destroyable-server";
import { Mockttp, AbstractMockttp, MockttpOptions } from "../mockttp";
import { MockRule } from "../rules/mock-rule";
import { MockedEndpoint } from "./mocked-endpoint";
import { createComboServer } from "./http-combo-server";
import { filter } from "../util/promise";

import {
    parseBody,
    waitForCompletedRequest,
    trackResponse,
    waitForCompletedResponse,
} from "./request-utils";
import { WebSocketHandler } from "./websocket-handler";

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

    private readonly initialDebugSetting: boolean;

    constructor(options: MockttpOptions = {}) {
        super(options);

        this.initialDebugSetting = this.debug;

        this.httpsOptions = options.https;
        this.eventEmitter = new EventEmitter();

        this.app = express();
        this.app.disable('x-powered-by');

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

        const port = (portParam || await portfinder.getPortPromise());

        if (this.debug) console.log(`Starting mock server on port ${port}`);

        this.server = await createComboServer({
            debug: this.debug,
            https: this.httpsOptions
        }, this.app);

        this.server!.listen(port);

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
            return "https://localhost:" + this.address.port;
        } else {
            return "http://localhost:" + this.address.port;
        }
    }

    get port(): number {
        if (!this.server) throw new Error('Cannot get port before server is started');

        return this.address.port;
    }

    public addRule = (ruleData: MockRuleData): Promise<MockedEndpoint> => {
        const rule = new MockRule(ruleData);
        this.rules.push(rule);
        return Promise.resolve(new MockedEndpoint(rule));
    }

    public on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;
    public on(event: 'abort', callback: (req: CompletedRequest) => void): Promise<void>;
    public on(event: string, callback: (...args: any[]) => void): Promise<void> {
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

    private async announceAbortAsync(request: OngoingRequest) {
        const req = await waitForCompletedRequest(request);
        this.eventEmitter.emit('abort', req);
    }

    private async handleRequest(rawRequest: express.Request, rawResponse: express.Response) {
        if (this.debug) console.log(`Handling request for ${rawRequest.url}`);

        const response = trackResponse(rawResponse);

        const id = uuid();

        const request = <OngoingRequest>Object.assign(rawRequest, { id: id });
        response.id = id;

        this.announceRequestAsync(request);

        let result: 'responded' | 'aborted' | null = null;
        response.once('close', () => {
            // Aborted is only defined in new node. We use it where it's explicitly false though.
            if (result === null && ((request as any).aborted !== false)) {
                this.announceAbortAsync(request);
                result = 'aborted';
            }
        });

        try {
            let matchingRules = await filter(this.rules, (r) => r.matches(request));
            let nextRule = matchingRules.filter((r) => !this.isComplete(r, matchingRules))[0];

            if (nextRule) {
                if (this.debug) console.log(`Request matched rule: ${nextRule.explain()}`);
                await nextRule.handleRequest(request, response);
            } else {
                await this.sendUnmatchedRequestError(request, response);
            }
            result = result || 'responded';
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
            try {
                response.end(e.toString());
                result = result || 'responded';
            } catch (e) {
                this.announceAbortAsync(request);
            }
        }

        if (result === 'responded') {
            this.announceResponseAsync(response);
        }
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

    private async sendUnmatchedRequestError(request: OngoingRequest, response: express.Response) {
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
}
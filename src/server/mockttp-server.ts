import http = require("http");
import portfinder = require("portfinder");
import express = require("express");
import cors = require("cors");
import bodyParser = require("body-parser");
import _ = require("lodash");

import { Method, Request, ProxyConfig } from "../types";
import { MockRuleData } from "../rules/mock-rule-types";
import PartialMockRule from "../rules/partial-mock-rule";
import destroyable, { DestroyableServer } from "../util/destroyable-server";
import { Mockttp, AbstractMockttp } from "../mockttp";
import { MockRule } from "../rules/mock-rule";
import { MockedEndpoint } from "./mocked-endpoint";

export interface MockServerOptions {
    cors?: boolean;
    debug?: boolean;
}

// Provides all the external API, uses that to build and manage the rules list, and interrogate our recorded requests
export default class MockttpServer extends AbstractMockttp implements Mockttp {
    private rules: MockRule[] = [];
    private debug: boolean;

    private app: express.Application;
    private server: DestroyableServer;

    constructor(options: MockServerOptions = {}) {
        super();
        this.debug = options.debug || false;
        this.app = express();

        if (options.cors) {
            if (this.debug) console.log('Enabling CORS');
            this.app.use(cors());
        }
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
        this.app.use(this.handleRequest.bind(this));
    }

    async start(port?: number): Promise<void> {
        port = (port || await new Promise<number>((resolve, reject) => {
            portfinder.getPort((err, port) => {
                if (err) reject(err);
                else resolve(port);
            });
        }));

        if (this.debug) console.log(`Starting mock server on port ${port}`);
        return new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(port, resolve));
        });
    }

    async stop(): Promise<void> {
        if (this.debug) console.log(`Stopping server at ${this.url}`);

        await this.server.destroy();
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

        return "http://localhost:" + this.server.address().port;
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

    private async handleRequest(request: Request, response: express.Response) {
        try {
            let matchingRules = this.rules.filter((r) => r.matches(request));
            let nextRule = matchingRules.filter((r) => !this.isComplete(r, matchingRules))[0]

            if (nextRule) {
                if (this.debug) console.log(`Request matched rule: ${nextRule.explain()}`);
                await nextRule.handleRequest(request, response);
            } else {
                if (this.debug) console.warn(`Unmatched request received: ${explainRequest(request)}`);

                response.setHeader('Content-Type', 'text/plain');
                response.writeHead(503, `Request for unmocked endpoint`);

                response.write("No rules were found matching this request.\n");
                response.write(`This request was: ${explainRequest(request)}\n\n`);

                if (this.rules.length > 0) {
                    response.write("The configured rules are:\n");
                    this.rules.forEach((rule) => response.write(rule.explain() + "\n"));
                } else {
                    response.write("There are no rules configured.\n");
                }

                response.end();
            }
        } catch (e) {
            console.error("Failed to handle request", e);
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
}

function explainRequest(request: Request) {
    let msg = `${request.method} request to ${request.url}`;

    if (request.body && request.body.length > 0) {
        msg += ` with body \`${request.body}\``;
    }

    if (!_.isEmpty(request.headers)) {
        msg += ` with headers:\n${JSON.stringify(request.headers, null, 2)}`;
    }

    return msg;
}

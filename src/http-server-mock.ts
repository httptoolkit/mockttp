import http = require("http");
import portfinder = require("portfinder");
import express = require("express");
import bodyParser = require('body-parser');
import _ = require('lodash');

import { Method, Request } from "./types";
import { MockRule } from "./rules/mock-rule-types";
import PartialMockRule from "./rules/partial-mock-rule";
import destroyable, { DestroyableServer } from "./destroyable-server";

// Provides all the external API, uses that to build and manage the rules list, and interrogate our recorded requests
export default class HttpServerMock {
    private rules: MockRule[] = [];
    private debug: boolean = false;

    private app: express.Application;
    private server: DestroyableServer;

    constructor() {
        this.app = express();

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
        await new Promise<void>((resolve, reject) => {
            try {
                this.server.destroy(resolve);
            } catch (e) {
                reject(e);
            }
        });
        this.reset();
    }

    enableDebug() {
        this.debug = true;
    }

    reset() {
        this.rules = [];
        this.debug = false;
    }

    get url(): string {
        return "http://localhost:" + this.server.address().port;
    }

    get proxyEnv() {
        return {
            HTTP_PROXY: this.url,
            HTTPS_PROXY: this.url
        }
    }

    urlFor(path: string): string {
        return this.url + path;
    }

    get(url: string): PartialMockRule {
        return new PartialMockRule(Method.GET, url, this.addRule);
    }

    post(url: string): PartialMockRule {
        return new PartialMockRule(Method.POST, url, this.addRule);
    }

    put(url: string): PartialMockRule {
        return new PartialMockRule(Method.PUT, url, this.addRule);
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

                response.writeHead(503, `Request for unmocked endpoint`);
                response.write("No rules were found matching this request.\n");
                response.write(`This request was: ${explainRequest(request)}\n\n`);
                // TODO: You could match this with...

                response.write("The configured rules are:\n");
                this.rules.forEach((rule) => response.write(rule.explain() + "\n"));

                response.end();
            }
        } catch (e) {
            console.error("Failed to handle request", e);
        }
    }

    private addRule = (rule: MockRule) => {
        this.rules.push(rule);
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

    return msg;
}

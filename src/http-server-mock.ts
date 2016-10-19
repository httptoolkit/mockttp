import http = require("http");
import portfinder = require("portfinder");

import { Method } from "./common-types";
import { MockRule } from "./rules/mock-rule-types";
import PartialMockRule from "./rules/partial-mock-rule";
import destroyable from "./destroyable-server";

// Provides all the external API, uses that to build and manage the rules list, and interrogate our recorded requests
export default class HttpServerMock {
    private rules: MockRule[] = [];

    private server = destroyable(http.createServer(this.handleRequest.bind(this)));

    async start(port?: number): Promise<void> {
        port = (port || await new Promise<number>((resolve, reject) => {
            portfinder.getPort((err, port) => {
                if (err) reject(err);
                else resolve(port);
            });
        }));

        return new Promise<void>((resolve, reject) => this.server.listen(port, resolve));
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

    reset() {
        this.rules = [];
    }

    get url(): string {
        return "http://localhost:" + this.server.address().port;
    }

    urlFor(path: string): string {
        return this.url + path;
    }

    get(url: string): PartialMockRule {
        return new PartialMockRule(this.addRule, Method.GET, url);
    }

    post(url: string): PartialMockRule {
        return new PartialMockRule(this.addRule, Method.POST, url);
    }

    put(url: string): PartialMockRule {
        return new PartialMockRule(this.addRule, Method.PUT, url);
    }

    private addRule = (rule: MockRule) => {
        this.rules.push(rule);
    }

    private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        try {
            let matchingRules = this.rules.filter((r) => r.matches(request));

            if (matchingRules.length > 0) {
                let nextRule = matchingRules.filter((r) => !r.isComplete())[0] ||
                               matchingRules[matchingRules.length - 1];
                await nextRule.handleRequest(request, response);
            } else {
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
}

function explainRequest(request: http.IncomingMessage) {
    return `${request.method} request to ${request.url}`;
}

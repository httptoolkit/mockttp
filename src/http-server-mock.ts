import http = require("http");
import portfinder = require("portfinder");

import { Method } from "./common-types";
import { MockRule } from "./rules/mock-rule-types";
import PartialMockRule from "./rules/partial-mock-rule";
import destroyable from "./destroyable-server";

declare module "http" {
    interface IncomingMessage {
        body: string;
    }
}

// Provides all the external API, uses that to build and manage the rules list, and interrogate our recorded requests
export default class HttpServerMock {
    private rules: MockRule[] = [];
    private debug: boolean = false;

    private server = destroyable(http.createServer(this.handleRequest.bind(this)));

    async start(port?: number): Promise<void> {
        port = (port || await new Promise<number>((resolve, reject) => {
            portfinder.getPort((err, port) => {
                if (err) reject(err);
                else resolve(port);
            });
        }));

        if (this.debug) console.log(`Starting mock server on port ${port}`);
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

    private async readBody(request: http.IncomingMessage): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            var body = "";
            request.on('data', function(chunk) {
                body += chunk;
            });
            request.on('end', function() {
                resolve(body);
            });
            request.on('error', reject);
        });
    }

    private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        try {
            request.body = await this.readBody(request);
            let matchingRules = this.rules.filter((r) => r.matches(request));

            if (matchingRules.length > 0) {
                let nextRule = matchingRules.filter((r) => !r.isComplete())[0] ||
                               matchingRules[matchingRules.length - 1];
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
}

function explainRequest(request: http.IncomingMessage) {
    let msg = `${request.method} request to ${request.url}`;

    if (request.body && request.body.length > 0) {
        msg += ` with body \`${request.body}\``;
    }

    return msg;
}

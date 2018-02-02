import net = require("net");
import http = require("http");
import https = require("https");
import tls = require('tls');
import portfinder = require("portfinder");
import express = require("express");

import cors = require("cors");
import bodyParser = require("body-parser");
import _ = require("lodash");

import * as fs from '../util/fs';
import { Method, Request, ProxyConfig } from "../types";
import { MockRuleData } from "../rules/mock-rule-types";
import PartialMockRule from "../rules/partial-mock-rule";
import { CA } from '../util/tls';
import destroyable, { DestroyableServer } from "../util/destroyable-server";
import { Mockttp, AbstractMockttp } from "../mockttp";
import { MockRule } from "../rules/mock-rule";
import { MockedEndpoint } from "./mocked-endpoint";

export type HttpsOptions = {
    key: string
    cert: string
};

export type HttpsPathOptions = {
    keyPath: string;
    certPath: string;
}

export interface MockServerOptions {
    cors?: boolean;
    debug?: boolean;
    https?: HttpsOptions | HttpsPathOptions
}

// TODO: Refactor this into the CA?
function buildHttpsOptions(options: HttpsOptions | HttpsPathOptions | undefined): Promise<HttpsOptions> | undefined {
    if (!options) return undefined;
    // TODO: is there a nice way to avoid these casts?
    if ((<any>options).key && (<any>options).cert) {
        return Promise.resolve(<HttpsOptions>options);
    }
    if ((<any>options).keyPath && (<any>options).certPath) {
        let pathOptions = <HttpsPathOptions>options;
        return Promise.all([
            fs.readFile(pathOptions.keyPath, 'utf8'),
            fs.readFile(pathOptions.certPath, 'utf8')
        ]).then(([keyContents, certContents]) => ({
            key: keyContents,
            cert: certContents
        }));
    }
    else {
        throw new Error('Unrecognized https option: you need to provide either a keyPath & certPath, or a key & cert.')
    }
}

// Provides all the external API, uses that to build and manage the rules list, and interrogate our recorded requests
export default class MockttpServer extends AbstractMockttp implements Mockttp {
    private rules: MockRule[] = [];

    private debug: boolean;
    private httpsOptions: Promise<HttpsOptions> | undefined;

    private app: express.Application;
    private server: DestroyableServer;

    constructor(options: MockServerOptions = {}) {
        super();
        this.debug = options.debug || false;

        this.httpsOptions = buildHttpsOptions(options.https);

        this.app = express();

        if (options.cors) {
            if (this.debug) console.log('Enabling CORS');
            this.app.use(cors());
        }

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
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
            let { key, cert } = await this.httpsOptions;
            const ca = new CA(key, cert);

            this.server = destroyable(https.createServer({
                key,
                cert,
                ca: [cert],
                // TODO: Fix node types for this callback
                SNICallback: (domain, cb: any) => {
                    if (this.debug) console.log(`Generating certificate for ${domain}`);
                    try {
                        const generatedCert = ca.generateCertificate(domain);
                        cb(null, tls.createSecureContext({
                            key: generatedCert.key,
                            cert: generatedCert.cert
                        }))
                    } catch (e) {
                        console.error('Cert generation error', e);
                        cb(e);
                    }
                }
            }, this.app).listen(port));

            this.server.addListener('connect', (req: http.IncomingMessage, socket: net.Socket) => {
                const [targetHost, port] = req.url!.split(':');
                if (this.debug) console.log(`Proxying connection to ${targetHost}`);

                socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', () => {
                    const generatedCert = ca.generateCertificate(targetHost);

                    let tlsSocket = new tls.TLSSocket(socket, {
                        isServer: true,
                        secureContext: tls.createSecureContext({
                            key: generatedCert.key,
                            cert: generatedCert.cert
                        })
                    });

                    http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
                        req.url = `https://${targetHost}:${port}${req.url}`;
                        return this.app(<express.Request>req, <express.Response>res);
                    }).emit('connection', tlsSocket);
                });
            });
        } else {
            return new Promise<void>((resolve, reject) => {
                this.server = destroyable(this.app.listen(port, resolve));
            });
        }

        return new Promise<void>((resolve, reject) => {
            this.server.on('listening', resolve);
            this.server.on('error', (e: any) => {
                // Although we try to pick a free port, we may have race conditions, if something else
                // takes the same port at the same time. If you haven't explicitly picked a port, and
                // we do have a collision, simply try again.
                if (e.code === 'EADDRINUSE' && !portParam) {
                    if (this.debug) console.log('Address in use, retrying...');

                    this.server.close(); // Don't bother waiting for this, it can stop on its own time
                    resolve(this.start());
                } else {
                    throw e;
                }
            });
        });
    }

    async stop(): Promise<void> {
        if (this.debug) console.log(`Stopping server at ${this.url}`);

        await this.server.destroy();
        this.reset();
    }

    async pendingMocks(): Promise<any> {
        var mockedEndpoints = this.mockedEndpoints;
        var result: string[] = [];
        for (var mockedEndpoint of mockedEndpoints) {
            var requests = mockedEndpoint.pendingMocks();
            result = result.concat(requests);
        }
        return result;
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
                response.writeHead(503, "Request for unmocked endpoint");

                response.write("No rules were found matching this request.\n");
                response.write(`This request was: ${explainRequest(request)}\n\n`);

                if (this.rules.length > 0) {
                    response.write("The configured rules are:\n");
                    this.rules.forEach((rule) => response.write(rule.explain() + "\n"));
                } else {
                    response.write("There are no rules configured.\n");
                }

                response.write(suggestRule(request));

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

function explainRequest(request: Request): string {
    let msg = `${request.method} request to ${request.url}`;

    if (request.body && request.body.length > 0) {
        msg += ` with body \`${request.body}\``;
    }

    if (!_.isEmpty(request.headers)) {
        msg += ` with headers:\n${JSON.stringify(request.headers, null, 2)}`;
    }

    return msg;
}

function suggestRule(request: Request): string {
    let msg = "You can fix this by adding a rule to match this request, for example:\n"

    msg += `mockServer.${request.method.toLowerCase()}("${request.path}")`;

    let isFormRequest = request.headers["content-type"] && request.headers["content-type"].indexOf("application/x-www-form-urlencoded") > -1;
    let hasFormBody = _.isPlainObject(request.body) && !_.isEmpty(request.body);

    if (isFormRequest && hasFormBody) {
        msg += `.withForm(${JSON.stringify(request.body)})`;
    }

    msg += '.thenReply(200, "your response");';

    return msg;
}
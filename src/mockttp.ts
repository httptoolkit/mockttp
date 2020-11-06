/**
 * @module Mockttp
 */
import * as http from "http";
import { stripIndent } from "common-tags";
import * as cors from 'cors';

import MockRuleBuilder from "./rules/mock-rule-builder";
import {
    ProxyConfig,
    MockedEndpoint,
    Method,
    CompletedRequest,
    CompletedResponse,
    TlsRequest,
    InitiatedRequest,
    ClientError,
    OngoingRequest
} from "./types";
import { MockRuleData } from "./rules/mock-rule";
import { CAOptions } from './util/tls';

export type PortRange = { startPort: number, endPort: number };

/**
 * A mockttp instance allow you to start and stop mock servers and control their behaviour.
 *
 * Call `.start()` to set up a server on a random port, use methods like `.get(url)`,
 * `.post(url)` and `.anyRequest()` to get a {@link MockRuleBuilder} and start defining
 * mock rules. Call `.stop()` when your test is complete.
 */
export interface Mockttp {
    /**
     * Start a mock server.
     *
     * Specify a fixed port if you need one.
     *
     * If you don't, a random port will be chosen, which you can get later with `.port`,
     * or by using `.url` and `.urlFor(path)` to generate your URLs automatically.
     *
     * If you need to allow port selection, but in a specific range, pass a
     * { startPort, endPort } pair to define the allowed (inclusive) range.
     */
    start(port?: number | PortRange): Promise<void>;

    /**
     * Stop the mock server and reset the rules.
     */
    stop(): Promise<void>;

    /**
     * Enable extra debug output so you can understand exactly what the server is doing.
     */
    enableDebug(): void;

    /**
     * Reset the stored rules. Most of the time it's better to start & stop the server instead,
     * but this can be useful in some special cases.
     */
    reset(): void;

    /**
     * The root URL of the server.
     *
     * This will throw an error if read before the server is started.
     */
    url: string;

    /**
     * The URL for a given path on the server.
     *
     * This will throw an error if read before the server is started.
     */
    urlFor(path: string): string;
    /**
     * The port the server is running on.
     *
     * This will throw an error if read before the server is started.
     */
    port: number;
    /**
     * The environment variables typically needed to use this server as a proxy, in a format you
     * can add to your environment straight away.
     *
     * This will throw an error if read before the server is started.
     *
     * ```
     * process.env = Object.assign(process.env, mockServer.proxyEnv)
     * ```
     */
    proxyEnv: ProxyConfig;

    /**
     * Get a builder for a mock rule that will match any requests on any path.
     */
    anyRequest(): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match GET requests for the given path.
     * If no path is specified, this matches all GET requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    get(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match POST requests for the given path.
     * If no path is specified, this matches all POST requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    post(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match PUT requests for the given path.
     * If no path is specified, this matches all PUT requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    put(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match DELETE requests for the given path.
     * If no path is specified, this matches all DELETE requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    delete(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match PATCH requests for the given path.
     * If no path is specified, this matches all PATCH requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    patch(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match HEAD requests for the given path.
     * If no path is specified, this matches all HEAD requests.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     */
    head(url?: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match OPTIONS requests for the given path.
     *
     * The path can be either a string, or a regular expression to match against.
     * Path matching always ignores query parameters. To match query parameters,
     * use .withQuery({ a: 'b' }) or withExactQuery('?a=b').
     *
     * There are a few supported matching formats:
     * - Relative string paths (`/abc`) will be compared only to the request's path,
     *   independent of the host & protocol, ignoring query params.
     * - Absolute string paths with no protocol (`localhost:8000/abc`) will be
     *   compared to the URL independent of the protocol, ignoring query params.
     * - Fully absolute string paths (`http://localhost:8000/abc`) will be compared
     *   to entire URL, ignoring query params.
     * - Regular expressions can match the absolute URL: `/^http:\/\/localhost:8000\/abc$/`
     * - Regular expressions can also match the path: `/^\/abc/`
     *
     * This can only be used if the `cors` option has been set to false.
     *
     * If cors is true (the default when using a remote client, e.g. in the browser),
     * then the mock server automatically handles OPTIONS requests to ensure requests
     * to the server are allowed by clients observing CORS rules.
     *
     * You can pass `{cors: false}` to `getLocal`/`getRemote` to disable this behaviour,
     * but if you're testing in a browser you will need to ensure you mock all OPTIONS
     * requests appropriately so that the browser allows your other requests to be sent.
     */
    options(url?: string | RegExp): MockRuleBuilder;

    /**
     * Subscribe to hear about request details as soon as the initial request details
     * (method, path & headers) are received, without waiting for the body.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'request-initiated', callback: (req: InitiatedRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about request details once the request is fully received.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about response details when the response is completed.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;

    /**
     * Subscribe to hear about requests that are aborted before the request or
     * response is fully completed.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'abort', callback: (req: InitiatedRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about requests that start a TLS handshake, but fail to complete it.
     * Not all clients report TLS errors explicitly, so this event fires for explicitly
     * reported TLS errors, and for TLS connections that are immediately closed with no
     * data sent.
     *
     * This is typically useful to detect clients who aren't correctly configured to trust
     * the configured HTTPS certificate. The callback is given the host name provided
     * by the client via SNI, if SNI was used (it almost always is).
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server, independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'tls-client-error', callback: (req: TlsRequest) => void): Promise<void>;

    /**
     * Deprecated alias for tls-client-error event
     * @deprecated
     */
    on(event: 'tlsClientError', callback: (req: TlsRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about requests that fail before successfully sending their
     * initial parameters (the request line & headers). This will fire for requests
     * that drop connections early, send invalid or too-long headers, or aren't
     * correctly parseable in some form.
     *
     * This is typically useful to detect clients who aren't correctly configured.
     * The callback is given an object containing the request (as we were best
     * able to parse it) and either the error response returned, or 'aborted'
     * if the connection was disconnected before the server could respond.
     *
     * This is only useful in some niche use cases, such as logging all requests
     * seen by the server, independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'client-error', callback: (error: ClientError) => void): Promise<void>;

    /**
     * Adds the given rules to the server.
     *
     * This API is only useful if you're manually building rules, rather than
     * using MockRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     */
    addRules(...ruleData: MockRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Set the given rules as the only rules on the server, replacing any
     * existing rules.
     *
     * This API is only useful if you're manually building rules, rather than
     * using MockRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     */
    setRules(...ruleData: MockRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Returns the set of currently registered mock endpoints.
     */
    getMockedEndpoints(): Promise<MockedEndpoint[]>;

    /**
     * Returns the set of registered but pending mock endpoints: endpoints which either
     * haven't seen the specified number of requests (if one was specified
     * e.g. with .twice()) or which haven't seen at least one request, by default.
     */
    getPendingEndpoints(): Promise<MockedEndpoint[]>;
}

export interface MockttpOptions {
    /**
     * Should the server automatically respond to OPTIONS requests with a permissive
     * response?
     *
     * Defaults to true for remote clients (e.g. in the browser), and false otherwise.
     * If this is set to false, browser requests will typically fail unless you
     * stub OPTIONS responses by hand.
     */
    cors?: boolean | cors.CorsOptions;

    /**
     * Should the server print extra debug information?
     */
    debug?: boolean;

    /**
     * The HTTPS settings to be used. Optional, only HTTP interception will be
     * enabled if omitted. This should be set to either a { key, cert } object
     * containing the private key and certificate in PEM format, or a { keyPath,
     * certPath } object containing the path to files containing that content.
     */
    https?: CAOptions;

    /**
     * Should HTTP/2 be enabled? Can be true, false, or 'fallback'. If true,
     * HTTP/2 is used for all clients supporting it. If false, HTTP/2 is never
     * used. If 'fallback' HTTP/2 is used only for clients that do not advertise
     * support for HTTP/1.1, but HTTP/1.1 is used by preference in all other
     * cases.
     *
     * Client HTTP/2 support is only advertised as part of the TLS options.
     * When no HTTPS configuration is provided, 'fallback' is equivalent to
     * false.
     */
    http2?: true | 'fallback' | false;

    /**
     * The full URL to use for a standalone server with remote (or local but browser) client.
     * When using a local server, this parameter is ignored.
     */
    standaloneServerUrl?: string;

    /**
     * By default, requests that match no rules will receive an explanation of the
     * request & existing rules, followed by some suggested example Mockttp code
     * which could be used to match the rule.
     *
     * In some cases where the end client is unaware of Mockttp, these example
     * suggestions are just confusing. Set `suggestChanges` to false to disable it.
     */
    suggestChanges?: boolean;

    /**
     * Specify a list of hostnames and/or specific host:port addresses, for which
     * certificate errors should be ignored, allowing the use of self-signed or
     * otherwise invalid WSS certificates.
     *
     * This is a temporary API, and will be removed in future, once full websocket
     * interception and mocking support is available so that this option can be
     * configured on individual rules instead.
     */
    ignoreWebsocketHostCertificateErrors?: string[];

    /**
     * Record the requests & response for all traffic matched by each rule, and make
     * it available via endpoint.getSeenRequests().
     *
     * Defaults to true. It can be useful to set this to false if lots of data will
     * be sent to/via the server, to avoid storing all traffic in memory unnecessarily,
     * if getSeenRequests will not be used.
     *
     * If this is set to false then getSeenRequests() will always return
     * an empty array. This only disables the built-in persistence of request data,
     * so traffic can still be captured live or stored elsewhere using
     * .on('request') & .on('response').
     */
    recordTraffic?: boolean;

    /**
     * The maximum body size to process, in bytes.
     *
     * Bodies larger than this will be dropped, becoming empty, so they won't match
     * body matchers, won't be available in .seenRequests, and won't be included in
     * subscribed event data. Body data will still typically be included in passed
     * through request & response data, in most cases, so this won't affect the
     * external HTTP clients otherwise.
     */
    maxBodySize?: number;

    /**
     * HTTP handler for requests without a route.
     *
     * If not set, it will show the error page of a non-configured routes instead.
     */
    unmatchedRequestHandler?: (request: OngoingRequest, response: http.ServerResponse) => Promise<void>
}

/**
 * @hidden
 */
export abstract class AbstractMockttp {
    protected corsOptions: boolean | cors.CorsOptions;
    protected debug: boolean;
    protected recordTraffic: boolean;
    protected suggestChanges: boolean;
    protected ignoreWebsocketHostCertificateErrors: string[];
    protected unmatchedRequestHandler?: (request: OngoingRequest, response: http.ServerResponse) => Promise<void>;

    abstract get url(): string;
    abstract on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;

    constructor(options: MockttpOptions) {
        this.debug = options.debug || false;
        this.corsOptions = options.cors || false;
        this.recordTraffic = options.recordTraffic !== undefined
            ? options.recordTraffic
            : true;
        this.suggestChanges = options.suggestChanges !== undefined
            ? options.suggestChanges
            : true;
        this.ignoreWebsocketHostCertificateErrors =
            options.ignoreWebsocketHostCertificateErrors || [];
        this.unmatchedRequestHandler = options.unmatchedRequestHandler
    }

    get proxyEnv(): ProxyConfig {
        return {
            HTTP_PROXY: this.url,
            HTTPS_PROXY: this.url
        }
    }

    urlFor(path: string): string {
        return this.url + path;
    }

    abstract addRules: (...ruleData: MockRuleData[]) => Promise<MockedEndpoint[]>;
    addRule = (rule: MockRuleData) =>
        this.addRules(rule).then((rules) => rules[0]);

    abstract setRules(...ruleData: MockRuleData[]): Promise<MockedEndpoint[]>;

    anyRequest(): MockRuleBuilder {
        return new MockRuleBuilder(this.addRule);
    }

    get(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.GET, url, this.addRule);
    }

    post(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.POST, url, this.addRule);
    }

    put(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.PUT, url, this.addRule);
    }

    delete(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.DELETE, url, this.addRule);
    }

    patch(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.PATCH, url, this.addRule);
    }

    head(url?: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.HEAD, url, this.addRule);
    }

    options(url?: string | RegExp): MockRuleBuilder {
        if (this.corsOptions) {
            throw new Error(stripIndent`
                Cannot mock OPTIONS requests with CORS enabled.

                You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues ${''
                }connecting to your mock server from browsers, unless you mock all required OPTIONS preflight ${''
                }responses by hand.
            `);
        }
        return new MockRuleBuilder(Method.OPTIONS, url, this.addRule);
    }

}
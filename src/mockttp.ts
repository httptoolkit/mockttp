import { stripIndent } from "common-tags";
import * as cors from 'cors';

import type { CAOptions } from './util/tls';

import { RequestRuleBuilder } from "./rules/requests/request-rule-builder";
import { WebSocketRuleBuilder } from "./rules/websockets/websocket-rule-builder";

import {
    ProxyEnvConfig,
    MockedEndpoint,
    Method,
    CompletedRequest,
    CompletedResponse,
    TlsPassthroughEvent,
    TlsHandshakeFailure,
    InitiatedRequest,
    ClientError,
    RulePriority,
    WebSocketMessage,
    WebSocketClose,
    AbortedRequest,
    RuleEvent
} from "./types";
import type { RequestRuleData } from "./rules/requests/request-rule";
import type { WebSocketRuleData } from "./rules/websockets/websocket-rule";

export type PortRange = { startPort: number, endPort: number };

/**
 * A mockttp instance allow you to start and stop mock servers and control their behaviour.
 *
 * This should be created using the exported {@link getLocal} or {@link getRemote} methods, like
 * so:
 *
 * ```
 * const mockServer = require('mockttp').getLocal()
 * ```
 *
 * Call `.start()` to set up a server on a random port, use `.forX` methods like `.forGet(url)`,
 * `.forPost(url)` and `.forAnyRequest()` to get a {@link RequestRuleBuilder} and start defining
 * mock rules. You can also mock WebSocket requests using `.forAnyWebSocket()`. Call `.stop()`
 * when your test is complete. An example:
 *
 * ```
 * await mockServer.start();
 * await mockServer.forGet('/abc').thenReply(200, "a response");
 * // ...Make some requests
 * await mockServer.stop();
 * ```
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
     *
     * @category Setup
     */
    start(port?: number | PortRange): Promise<void>;

    /**
     * Stop the mock server and reset all rules and subscriptions.
     *
     * @category Setup
     */
    stop(): Promise<void>;

    /**
     * Enable extra debug output so you can understand exactly what the server is doing.
     *
     * @category Setup
     */
    enableDebug(): void;

    /**
     * Reset the stored rules and subscriptions. Most of the time it's better to start & stop
     * the server instead, but this can be useful in some special cases.
     *
     * @category Setup
     */
    reset(): void;

    /**
     * The root URL of the server.
     *
     * This will throw an error if read before the server is started.
     *
     * @category Metadata
     */
    url: string;

    /**
     * The URL for a given path on the server.
     *
     * This will throw an error if read before the server is started.
     *
     * @category Metadata
     */
    urlFor(path: string): string;

    /**
     * The port the server is running on.
     *
     * This will throw an error if read before the server is started.
     *
     * @category Metadata
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
     *
     * @category Metadata
     */
    proxyEnv: ProxyEnvConfig;

    /**
     * Get a builder for a mock rule that will match any requests on any path.
     *
     * This only matches traditional HTTP requests, not websockets, which are handled
     * separately. To match websockets, use `.forAnyWebSocket()`.
     *
     * @category Mock HTTP requests
     */
    forAnyRequest(): RequestRuleBuilder;

    /**
     * Get a builder for a fallback mock rule that will match any unmatched requests
     * on any path.
     *
     * Fallback rules act like any other rule, but they only match if there is no
     * existing normal rule that matches the request, or if all existing rules have
     * an explicit execution limit (like `once()`) that has been completed.
     *
     * @category Mock HTTP requests
     */
    forUnmatchedRequest(): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forGet(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forPost(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forPut(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forDelete(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forPatch(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forHead(url?: string | RegExp): RequestRuleBuilder;

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
     *
     * @category Mock HTTP requests
     */
    forOptions(url?: string | RegExp): RequestRuleBuilder;

    /**
     * Match JSON-RPC requests, optionally matching a given method and/or params.
     *
     * If no method or params are specified, this will match all JSON-RPC requests.
     *
     * Params are matched flexibly, using the same logic as .withJsonBodyIncluding(),
     * so only the included fields are checked and other extra fields are ignored
     *
     * @category Mock HTTP requests
     */
    forJsonRpcRequest(match?: { method?: string, params?: any }): RequestRuleBuilder;

    /**
     * Get a builder for a mock rule that will match all websocket connections.
     *
     * @category Mock websockets
     */
    forAnyWebSocket(): WebSocketRuleBuilder;

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
     *
     * @category Events
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
     *
     * @category Events
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
     *
     * @category Events
     */
    on(event: 'response', callback: (req: CompletedResponse) => void): Promise<void>;

    /**
     * Subscribe to hear about websocket connection requests. This event fires when the
     * initial WebSocket request is completed, regardless of whether the request is
     * accepted.
     *
     * This is only useful in some niche use cases, such as logging all websockets seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'websocket-request', callback: (req: CompletedRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about websocket connection upgrades. This event fires when a
     * WebSocket request is accepted, returning the HTTP response body that was sent
     * before the WebSocket stream starts.
     *
     * This is only useful in some niche use cases, such as logging all websockets seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'websocket-accepted', callback: (req: CompletedResponse) => void): Promise<void>;

    /**
     * Subscribe to hear about websocket messages received by Mockttp from its downstream
     * websocket clients. This event fires whenever any data is received on an open
     * mocked WebSocket.
     *
     * This is only useful in some niche use cases, such as logging all websockets seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'websocket-message-received', callback: (req: WebSocketMessage) => void): Promise<void>;

    /**
     * Subscribe to hear about websocket messages sent by Mockttp to its downstream
     * websocket clients. This event fires whenever any data is sent on an open
     * mocked WebSocket.
     *
     * This is only useful in some niche use cases, such as logging all websockets seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'websocket-message-sent', callback: (req: WebSocketMessage) => void): Promise<void>;

    /**
     * Subscribe to hear when a websocket connection is closed. This fires only for clean
     * websocket shutdowns, after the websocket was initially accepted. If the connection
     * is closed uncleanly, an 'abort' event will fire instead. If the websocket was
     * initially rejected explicitly, a 'response' event (with the rejecting response) will
     * fire instead.
     *
     * This is only useful in some niche use cases, such as logging all websockets seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'websocket-close', callback: (req: WebSocketClose) => void): Promise<void>;

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
     *
     * @category Events
     */
    on(event: 'abort', callback: (req: AbortedRequest) => void): Promise<void>;

    /**
     * Subscribe to hear about TLS connections that are passed through the proxy without
     * interception, due to the `tlsPassthrough` HTTPS option.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server, independently of the rules defined.
     *
     * The callback will be called asynchronously from connection handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'tls-passthrough-opened', callback: (req: TlsPassthroughEvent) => void): Promise<void>;

    /**
     * Subscribe to hear about closure of TLS connections that were passed through the
     * proxy without interception, due to the `tlsPassthrough` HTTPS option.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server, independently of the rules defined.
     *
     * The callback will be called asynchronously from connection handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on(event: 'tls-passthrough-closed', callback: (req: TlsPassthroughEvent) => void): Promise<void>;

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
     *
     * @category Events
     */
    on(event: 'tls-client-error', callback: (req: TlsHandshakeFailure) => void): Promise<void>;

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
     *
     * @category Events
     */
    on(event: 'client-error', callback: (error: ClientError) => void): Promise<void>;

    /**
     * Some rules may emit events with metadata about request processing. For example,
     * passthrough rules may emit events about upstream server interactions.
     *
     * You can listen to rule-event to hear about all these events. When emitted,
     * this will include the id of the request being processed, the id of the rule
     * that fired the event, the type of the event, and the event data itself.
     *
     * This is only useful in some niche use cases, such as logging all proxied upstream
     * requests made by the server, separately from the client connections handled.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     *
     * @category Events
     */
    on<T = unknown>(event: 'rule-event', callback: (event: RuleEvent<T>) => void): Promise<void>;

    /**
     * Adds the given HTTP request rules to the server.
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    addRequestRules(...ruleData: RequestRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Adds the given HTTP request rule to the server.
     *
     * This is a convenient alias for calling `addRequestRules` with one rule,
     * and extracting the first endpoint result.
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    addRequestRule(ruleData: RequestRuleData): Promise<MockedEndpoint>;

    /**
     * Set the given HTTP request rules as the only request rules on the server,
     * replacing any existing rules (except websocket rules).
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    setRequestRules(...ruleData: RequestRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Adds the given websocket rules to the server.
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    addWebSocketRules(...ruleData: WebSocketRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Adds the given websocket rule to the server.
     *
     * This is a convenient alias for calling `addWebSocketRules` with one rule,
     * and extracting the first endpoint result.
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    addWebSocketRule(ruleData: WebSocketRuleData): Promise<MockedEndpoint>;

    /**
     * Set the given websocket rules as the only websocket rules on the server,
     * replacing all existing websocket rules (but leaving normal rules untouched).
     *
     * This API is only useful if you're manually building rules, rather than
     * using RequestRuleBuilder, and is only for special cases. This approach may
     * be necessary if you need to configure all your rules in one place to
     * enable them elsewhere/later.
     *
     * @category Manual rule definition
     */
    setWebSocketRules(...ruleData: WebSocketRuleData[]): Promise<MockedEndpoint[]>;

    /**
     * Returns the set of currently registered mock endpoints.
     *
     * @category Metadata
     */
    getMockedEndpoints(): Promise<MockedEndpoint[]>;

    /**
     * Returns the set of registered but pending mock endpoints: endpoints which either
     * haven't seen the specified number of requests (if one was specified
     * e.g. with .twice()) or which haven't seen at least one request, by default.
     *
     * @category Metadata
     */
    getPendingEndpoints(): Promise<MockedEndpoint[]>;

    /**
     * List the names of the rule parameters available for rule definitions. These
     * parameters are defined by the admin server. This list can be used in some
     * advanced use cases to confirm beforehand that the parameters a client wishes to
     * reference are available.
     *
     * Only relevant to remote/browser Mockttp usage. Servers created directly without any
     * admin server will never have rule parameters defined, and so this method will always
     * return an empty list.
     *
     * @category Metadata
     */
    getRuleParameterKeys(): Promise<string[]>;
}

export type MockttpHttpsOptions = CAOptions & {
    /**
     * The domain name that will be used in the certificate for incoming TLS
     * connections which don't use SNI to request a specific domain.
     */
    defaultDomain?: string;

    /**
     * A list of hostnames where TLS interception should always be skipped.
     *
     * When a TLS connection is started that references a matching hostname in its
     * server name indication (SNI) extension, or which uses a matching hostname
     * in a preceeding CONNECT request to create a tunnel, the connection will be
     * sent raw to the upstream hostname, without handling TLS within Mockttp (i.e.
     * with no TLS interception performed).
     *
     * This option is mutually exclusive with `tlsInterceptOnly` and setting both
     * options will throw an error.
     *
     * Each element in this list must be an object with a 'hostname' field for the
     * hostname that should be matched. Wildcards are supported (following the 
     * [URLPattern specification](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)),
     * eg. `{hostname: '*.example.com'}`.
     * 
     * In future more options may be supported
     * here for additional configuration of this behaviour.
     */
    tlsPassthrough?: Array<{ hostname: string }>;

    /**
     * A limited list of the only hostnames whose TLS should be intercepted.
     *
     * This is the opposite of `tlsPassthrough`. When set, only connections
     * to these hostnames will be intercepted, and all other TLS connections will
     * be passed through without interception.
     *
     * This option is mutually exclusive with `tlsPassthrough` and setting both
     * options will throw an error.
     *
     * Each element in this list must be an object with a 'hostname' field for the
     * hostname that should be matched. Wildcards are supported (following the 
     * [URLPattern specification](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)),
     * eg. `{hostname: '*.example.com'}`.
     * 
     * In future more options may be supported
     * here for additional configuration of this behaviour.
     */
    tlsInterceptOnly?: Array<{ hostname: string }>;

    /**
     * Set the TLS server options, used for incoming TLS connections.
     *
     * The only officially supported option for now is the minimum TLS version, which can
     * be used to relax/tighten TLS requirements on clients. If not set, this defaults
     * to your Node version's default TLS configuration. The full list of versions can be
     * found at https://nodejs.org/api/tls.html#tlssocketgetprotocol.
     */
    tlsServerOptions?: {
        minVersion?: 'TLSv1.3' | 'TLSv1.2' | 'TLSv1.1' | 'TLSv1';
    };
};

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
    https?: MockttpHttpsOptions;

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
     * By default, requests that match no rules will receive an explanation of the
     * request & existing rules, followed by some suggested example Mockttp code
     * which could be used to match the rule.
     *
     * In some cases where the end client is unaware of Mockttp, these example
     * suggestions are just confusing. Set `suggestChanges` to false to disable it.
     */
    suggestChanges?: boolean;

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
}

export type SubscribableEvent =
    | 'request-initiated'
    | 'request'
    | 'response'
    | 'websocket-request'
    | 'websocket-accepted'
    | 'websocket-message-received'
    | 'websocket-message-sent'
    | 'websocket-close'
    | 'abort'
    | 'tls-passthrough-opened'
    | 'tls-passthrough-closed'
    | 'tls-client-error'
    | 'client-error'
    | 'rule-event';

/**
 * @hidden
 */
export abstract class AbstractMockttp {
    protected corsOptions: boolean | cors.CorsOptions;
    protected debug: boolean;
    protected recordTraffic: boolean;
    protected suggestChanges: boolean;

    abstract get url(): string;
    abstract on(
        event: SubscribableEvent,
        callback: (req: CompletedRequest) => void
    ): Promise<void>;

    constructor(options: MockttpOptions) {
        this.debug = options.debug || false;
        this.corsOptions = options.cors || false;
        this.recordTraffic = options.recordTraffic !== undefined
            ? options.recordTraffic
            : true;
        this.suggestChanges = options.suggestChanges !== undefined
            ? options.suggestChanges
            : true;
    }

    get proxyEnv(): ProxyEnvConfig {
        return {
            HTTP_PROXY: this.url,
            HTTPS_PROXY: this.url
        }
    }

    urlFor(path: string): string {
        return this.url + path;
    }

    abstract addRequestRules: (...ruleData: RequestRuleData[]) => Promise<MockedEndpoint[]>;
    addRequestRule = (rule: RequestRuleData) =>
        this.addRequestRules(rule).then((rules) => rules[0]);

    abstract setRequestRules(...ruleData: RequestRuleData[]): Promise<MockedEndpoint[]>;

    abstract addWebSocketRules: (...ruleData: WebSocketRuleData[]) => Promise<MockedEndpoint[]>;
    addWebSocketRule = (rule: WebSocketRuleData) =>
        this.addWebSocketRules(rule).then((rules) => rules[0]);

    abstract setWebSocketRules(...ruleData: WebSocketRuleData[]): Promise<MockedEndpoint[]>;

    forAnyRequest(): RequestRuleBuilder {
        return new RequestRuleBuilder(this.addRequestRule);
    }

    forUnmatchedRequest(): RequestRuleBuilder {
        return new RequestRuleBuilder(this.addRequestRule)
            .asPriority(RulePriority.FALLBACK);
    }

    forGet(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.GET, url, this.addRequestRule);
    }

    forPost(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.POST, url, this.addRequestRule);
    }

    forPut(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.PUT, url, this.addRequestRule);
    }

    forDelete(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.DELETE, url, this.addRequestRule);
    }

    forPatch(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.PATCH, url, this.addRequestRule);
    }

    forHead(url?: string | RegExp): RequestRuleBuilder {
        return new RequestRuleBuilder(Method.HEAD, url, this.addRequestRule);
    }

    forOptions(url?: string | RegExp): RequestRuleBuilder {
        if (this.corsOptions) {
            throw new Error(stripIndent`
                Cannot mock OPTIONS requests with CORS enabled.

                You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues ${''
                }connecting to your mock server from browsers, unless you mock all required OPTIONS preflight ${''
                }responses by hand.
            `);
        }
        return new RequestRuleBuilder(Method.OPTIONS, url, this.addRequestRule);
    }

    forJsonRpcRequest(match: { method?: string, params?: any } = {}) {
        return new RequestRuleBuilder(this.addRequestRule)
            .withJsonBodyIncluding({
                jsonrpc: '2.0',
                ...(match.method ? { method: match.method } : {}),
                ...(match.params ? { params: match.params } : {})
            });
    }

    forAnyWebSocket(): WebSocketRuleBuilder {
        return new WebSocketRuleBuilder(this.addWebSocketRule);
    }

}
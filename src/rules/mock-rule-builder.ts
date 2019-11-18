/**
 * @module MockRule
 */

import { OutgoingHttpHeaders } from "http";
import { merge, isString, isBuffer } from "lodash";
import { Readable } from "stream";

import { Headers, CompletedRequest, Method, MockedEndpoint } from "../types";
import { MockRuleData } from "./mock-rule";

import {
    RuleCompletionChecker,
    Always,
    NTimes,
    Thrice,
    Twice,
    Once
} from "./completion-checkers";

import {
    RequestMatcher,
    MethodMatcher,
    SimplePathMatcher,
    RegexPathMatcher,
    HeaderMatcher,
    QueryMatcher,
    FormDataMatcher,
    RawBodyMatcher,
    WildcardMatcher,
    CookieMatcher,
    RegexBodyMatcher,
    JsonBodyMatcher,
    JsonBodyFlexibleMatcher,
    ExactQueryMatcher,
    HostMatcher
} from "./matchers";

import {
    SimpleHandler,
    PassThroughHandler,
    CallbackHandler,
    CallbackResponseResult,
    StreamHandler,
    CloseConnectionHandler,
    TimeoutHandler,
    PassThroughHandlerOptions,
    FileHandler,
} from "./handlers";
import { MaybePromise } from "../util/type-utils";

/**
 * @class MockRuleBuilder

 * A builder for defining mock rules. Create one using a method like
 * `.get(path)` or `.post(path)` on a Mockttp instance, then call
 * whatever methods you'd like here to define more precise request
 * matching behaviour, control how the request is handled, and how
 * many times this rule should be applied.
 *
 * When you're done, call a `.thenX()` method to register the configured rule
 * with the server. These return a promise for a MockedEndpoint, which can be
 * used to verify the details of the requests matched by the rule.
 *
 * This returns a promise because rule registration can be asynchronous,
 * either when using a remote server or testing in the browser. Wait for the
 * promise returned by `.thenX()` methods to guarantee that the rule has taken
 * effect before sending requests to it.
 */
export default class MockRuleBuilder {
    private addRule: (rule: MockRuleData) => Promise<MockedEndpoint>;

    /**
     * Mock rule builders should be constructed through the Mockttp instance you're
     * using, not directly. You shouldn't ever need to call this constructor.
     */
    constructor(addRule: (rule: MockRuleData) => Promise<MockedEndpoint>)
    constructor(
        method: Method,
        path: string | RegExp | undefined,
        addRule: (rule: MockRuleData) => Promise<MockedEndpoint>
    )
    constructor(
        methodOrAddRule: Method | ((rule: MockRuleData) => Promise<MockedEndpoint>),
        path?: string | RegExp,
        addRule?: (rule: MockRuleData) => Promise<MockedEndpoint>
    ) {
        if (methodOrAddRule instanceof Function) {
            this.matchers.push(new WildcardMatcher());
            this.addRule = methodOrAddRule;
            return;
        }

        this.matchers.push(new MethodMatcher(methodOrAddRule));

        if (path instanceof RegExp) {
            this.matchers.push(new RegexPathMatcher(path));
        } else if (typeof path === 'string') {
            this.matchers.push(new SimplePathMatcher(path));
        }
        this.addRule = addRule!;
    }

    private matchers: RequestMatcher[] = [];
    private completionChecker?: RuleCompletionChecker;

    /**
     * Match only requests sent to the given host
     */
    forHost(host: string) {
        this.matchers.push(new HostMatcher(host));
        return this;
    }

    /**
     * Match only requests that include the given headers.
     */
    withHeaders(headers: { [key: string]: string }) {
        this.matchers.push(new HeaderMatcher(headers));
        return this;
    }

    /**
     * Match only requests that include the given query parameters.
     */
    withQuery(query: { [key: string]: string | number | (string | number)[] }): MockRuleBuilder {
        this.matchers.push(new QueryMatcher(query));
        return this;
    }

    /**
     * Match only requests that include the exact query string provided.
     * The query string must start with a ? or be entirely empty.
     */
    withExactQuery(query: string): MockRuleBuilder {
        this.matchers.push(new ExactQueryMatcher(query));
        return this;
    }

    /**
     * Match only requests whose bodies include the given form data.
     */
    withForm(formData: { [key: string]: string }): MockRuleBuilder {
        this.matchers.push(new FormDataMatcher(formData));
        return this;
    }

    /**
     * Match only requests whose bodies either exactly match the given string
     * (if a string is passed) or whose bodies match a regular expression
     * (if a regex is passed).
     */
    withBody(content: string | RegExp): MockRuleBuilder {
        this.matchers.push(
            isString(content)
                ? new RawBodyMatcher(content)
                : new RegexBodyMatcher(content)
        );
        return this;
    }

    /**
     * Match only requests whose bodies exactly match the given
     * object, when parsed as JSON.
     *
     * Note that this only tests that the body can be parsed
     * as JSON - it doesn't require a content-type header.
     */
    withJsonBody(json: {}): MockRuleBuilder {
        this.matchers.push(
            new JsonBodyMatcher(json)
        );
        return this;
    }

    /**
     * Match only requests whose bodies match (contain equivalent
     * values, ignoring extra values) the given object, when
     * parsed as JSON. Matching behaviour is the same as Lodash's
     * _.isMatch method.
     *
     * Note that this only tests that the body can be parsed
     * as JSON - it doesn't require a content-type header.
     */
    withJsonBodyIncluding(json: {}): MockRuleBuilder {
        this.matchers.push(
            new JsonBodyFlexibleMatcher(json)
        );
        return this;
    }

    /**
     * Match only requests that include the given cookies
     */
    withCookie(cookie: { [key: string]: string }) {
        this.matchers.push(new CookieMatcher(cookie));
        return this;
    }

    /**
     * Run this rule forever, for all matching requests
     */
    always(): MockRuleBuilder {
        this.completionChecker = new Always();
        return this;
    }

    /**
     * Run this rule only once, for the first matching request
     */
    once(): MockRuleBuilder {
        this.completionChecker = new Once();
        return this;
    }

    /**
     * Run this rule twice, for the first two matching requests
     */
    twice(): MockRuleBuilder {
        this.completionChecker = new Twice();
        return this;
    }

    /**
     * Run this rule three times, for the first three matching requests
     */
    thrice(): MockRuleBuilder {
        this.completionChecker = new Thrice();
        return this;
    }

    /**
     * Run this rule the given number of times, for the first matching requests
     */
    times(n: number): MockRuleBuilder {
        this.completionChecker = new NTimes(n);
        return this;
    }

    /**
     * Reply to matched requests with a given status code and (optionally) status message,
     * body and headers.
     *
     * If one string argument is provided, it's used as the body. If two are
     * provided (even if one is empty), then 1st is the status message, and
     * the 2nd the body.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenReply(status: number, data?: string | Buffer, headers?: Headers): Promise<MockedEndpoint>;
    thenReply(status: number, statusMessage: string, data: string | Buffer, headers?: Headers): Promise<MockedEndpoint>
    thenReply(
        status: number,
        dataOrMessage?: string | Buffer,
        dataOrHeaders?: string | Buffer | Headers,
        headers?: Headers
    ): Promise<MockedEndpoint> {
        let data: string | Buffer | undefined;
        let statusMessage: string | undefined;
        if (isBuffer(dataOrHeaders) || isString(dataOrHeaders)) {
            data = dataOrHeaders as (Buffer | string);
            statusMessage = dataOrMessage as string;
        } else {
            data = dataOrMessage as string | Buffer | undefined;
            headers = dataOrHeaders as Headers | undefined;
        }

        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new SimpleHandler(status, statusMessage, data, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Reply to matched requests with the given status & JSON and (optionally)
     * extra headers.
     *
     * This method is shorthand for:
     * server.get(...).thenReply(status, JSON.stringify(data), { 'Content-Type': 'application/json' })
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenJson(status: number, data: object, headers: OutgoingHttpHeaders = {}): Promise<MockedEndpoint> {
        const defaultHeaders = { 'Content-Type': 'application/json' };
        merge(defaultHeaders, headers);

        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new SimpleHandler(status, undefined, JSON.stringify(data), defaultHeaders)
        };

        return this.addRule(rule);
    }

    /**
     * Deprecated alias for thenJson
     * @deprecated
     */
    thenJSON = this.thenJson;

    /**
     * Call the given callback for any matched requests that are received,
     * and build a response from the result.
     *
     * The callback should return a response object or a promise for one.
     * The response object may include various fields to define the response.
     * All fields are optional, and default to being empty/blank, except for
     * the status, which defaults to 200.
     *
     * Valid fields are:
     * - `status` (number)
     * - `body` (string or buffer)
     * - `headers` (object with string keys & values)
     * - `json` (object, which will be sent as a JSON response)
     *
     * If the callback throws an exception, the server will return a 500
     * with the exception message.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenCallback(callback:
        (request: CompletedRequest) => MaybePromise<CallbackResponseResult>
    ): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new CallbackHandler(callback)
        }

        return this.addRule(rule);
    }

    /**
     * Respond immediately with the given status (and optionally, headers),
     * and then stream the given stream directly as the response body.
     *
     * Note that streams can typically only be read once, and as such
     * this rule will only successfully trigger once. Subsequent requests
     * will receive a 500 and an explanatory error message. To mock
     * repeated requests with streams, create multiple streams and mock
     * them independently.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenStream(status: number, stream: Readable, headers?: Headers): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new StreamHandler(status, stream, headers)
        }

        return this.addRule(rule);
    }

    /**
     * Reply to matched requests with a given status code and the current contents
     * of a given file. The status message and headers can also be optionally
     * provided here.
     *
     * The file is read near-fresh for each request, and external changes to its
     * content will be immediately appear in all subsequent requests.
     *
     * If one string argument is provided, it's used as the body file path.
     * If two are provided (even if one is empty), then 1st is the status message,
     * and the 2nd the body. This matches the argument order of thenReply().
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenFromFile(status: number, filePath: string, headers?: Headers): Promise<MockedEndpoint>;
    thenFromFile(status: number, statusMessage: string, filePath: string, headers?: Headers): Promise<MockedEndpoint>
    thenFromFile(
        status: number,
        pathOrMessage: string,
        pathOrHeaders?: string | Headers,
        headers?: Headers
    ): Promise<MockedEndpoint> {
        let path: string;
        let statusMessage: string | undefined;
        if (isString(pathOrHeaders)) {
            path = pathOrHeaders;
            statusMessage = pathOrMessage as string;
        } else {
            path = pathOrMessage;
            headers = pathOrHeaders as Headers | undefined;
        }

        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new FileHandler(status, statusMessage, path, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Pass matched requests through to their real destination. This works
     * for proxied requests only, direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. The available options are:
     *
     * * ignoreHostCertificateErrors, a list of hostnames for which server
     *   certificate errors should be ignored (none, by default).
     * * clientCertificateHostMap, a mapping of hosts to client certificates to use,
     *   in the form of { key, cert } objects (none, by default)
     * * beforeRequest, a callback that will be passed the full request
     *   before it is passed through, and which returns an object that defines
     *   how the the request content should be changed before it's passed
     *   to the upstream server (details below).
     * * beforeResponse, a callback that will be passed the full response
     *   before it is completed, and which returns an object that defines
     *   how the the response content should be changed before it's returned
     *   to the client (details below).
     *
     * The beforeRequest & beforeResponse callbacks should return objects
     * defining how the request/response should be changed. All fields on
     * the object are optional. The valid fields are:
     *
     * Valid fields are:
     * - Request only: `method` (a replacement HTTP verb, capitalized)
     * - Request only: `url` (a full URL to send the request to)
     * - Request only: `response` (a response callback result: if provided
     *   this will be used directly, the request will not be passed through
     *   at all, and any beforeResponse callback will never fire)
     * - Response only: `status` (number, will replace the HTTP status code)
     * - Both: `headers` (object with string keys & values, replaces all
     *   headers if set)
     * - Both: `body` (string or buffer, replaces the body if set)
     * - Both: `json` (object, to be sent as a JSON-encoded body, taking
     *   precedence over `body` if both are set)
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenPassThrough(options?: PassThroughHandlerOptions): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughHandler(options)
        };

        return this.addRule(rule);
    }

    /**
     * Forward matched requests on to the specified forwardToUrl. The url
     * specified must not include a path. Otherwise, an error is thrown.
     * The path portion of the original request url is used instead.
     *
     * The url may optionally contain a protocol. If it does, it will override
     * the protocol (and potentially the port, if unspecified) of the request.
     * If no protocol is specified, the protocol (and potentially the port)
     * of the original request URL will be used instead.
     *
     * This method also takes options to configure how the request is passed
     * through, see thenPassThrough for more details.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    async thenForwardTo(
        forwardToLocation: string,
        options: Omit<PassThroughHandlerOptions, 'forwarding'> & {
            forwarding?: Omit<PassThroughHandlerOptions['forwarding'], 'targetHost'>
        } = {}
    ): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughHandler({
                ...options,
                forwarding: {
                    ...options.forwarding,
                    targetHost: forwardToLocation
                }
            })
        };

        return this.addRule(rule);
    }

    /**
     * Close connections that match this rule immediately, without
     * any status code or response.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenCloseConnection(): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new CloseConnectionHandler()
        };

        return this.addRule(rule);
    }

    /**
     * Hold open connections that match this rule, but never respond
     * with anything at all, typically causing a timeout on the client side.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenTimeout(): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new TimeoutHandler()
        };

        return this.addRule(rule);
    }
}

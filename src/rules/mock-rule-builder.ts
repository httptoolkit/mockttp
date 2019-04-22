/**
 * @module MockRule
 */

import url = require("url");
import { OutgoingHttpHeaders } from "http";
import { merge, defaults } from "lodash";
import { Readable } from "stream";
import { stripIndent } from "common-tags";

import { Headers, CompletedRequest, Method, MockedEndpoint } from "../types";

import {
    MockRuleData
} from "./mock-rule-types";

import {
    CompletionCheckerData,
    AlwaysData,
    TimesData,
    ThriceData,
    TwiceData,
    OnceData
} from "./completion-checkers";

import {
    MatcherData,
    MethodMatcherData,
    SimplePathMatcherData,
    RegexPathMatcherData,
    HeaderMatcherData,
    QueryMatcherData,
    FormDataMatcherData,
    RawBodyMatcherData,
    WildcardMatcherData,
    CookieMatcherData,
    RegexBodyMatcherData
} from "./matchers";

import {
    SimpleHandlerData,
    PassThroughHandlerData,
    CallbackHandlerData,
    CallbackHandlerResult,
    StreamHandlerData,
    CloseConnectionHandlerData,
    TimeoutHandlerData,
    PassThroughHandlerOptions
} from "./handlers";

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
        path: string | RegExp,
        addRule: (rule: MockRuleData) => Promise<MockedEndpoint>
    )
    constructor(
        methodOrAddRule: Method | ((rule: MockRuleData) => Promise<MockedEndpoint>),
        path?: string | RegExp,
        addRule?: (rule: MockRuleData) => Promise<MockedEndpoint>
    ) {
        if (methodOrAddRule instanceof Function) {
            this.matchers.push(new WildcardMatcherData());
            this.addRule = methodOrAddRule;
            return;
        }

        this.matchers.push(new MethodMatcherData(methodOrAddRule));

        if (path instanceof RegExp) {
            this.matchers.push(new RegexPathMatcherData(path));
            this.addRule = addRule!;
        } else {
            this.matchers.push(new SimplePathMatcherData(path!));
            this.addRule = addRule!;
        }
    }

    private matchers: MatcherData[] = [];
    private isComplete?: CompletionCheckerData;

    /**
     * Match only requests that include the given headers
     */
    withHeaders(headers: { [key: string]: string }) {
        this.matchers.push(new HeaderMatcherData(headers));
        return this;
    }

    /**
     * Match only requests that include the given query parameters
     */
    withQuery(query: { [key: string]: string | number }): MockRuleBuilder {
        this.matchers.push(new QueryMatcherData(query));
        return this;
    }

    /**
     * Match only requests whose bodies include the given form data
     */
    withForm(formData: { [key: string]: string }): MockRuleBuilder {
        this.matchers.push(new FormDataMatcherData(formData));
        return this;
    }

    /**
     * Match only requests whose bodies exactly match the given string
     */
    withBody(content: string): MockRuleBuilder {
        this.matchers.push(new RawBodyMatcherData(content));
        return this;
    }

    withMatchedBody(content: RegExp): MockRuleBuilder {
        this.matchers.push(new RegexBodyMatcherData(content));
        return this;
    }

    /**
     * Match only requests that include the given cookies
     */
    withCookie(cookie: { [key: string]: string }) {
        this.matchers.push(new CookieMatcherData(cookie));
        return this;
    }

    /**
     * Run this rule forever, for all matching requests
     */
    always(): MockRuleBuilder {
        this.isComplete = new AlwaysData();
        return this;
    }

    /**
     * Run this rule only once, for the first matching request
     */
    once(): MockRuleBuilder {
        this.isComplete = new OnceData();
        return this;
    }

    /**
     * Run this rule twice, for the first two matching requests
     */
    twice(): MockRuleBuilder {
        this.isComplete = new TwiceData();
        return this;
    }

    /**
     * Run this rule three times, for the first three matching requests
     */
    thrice(): MockRuleBuilder {
        this.isComplete = new ThriceData();
        return this;
    }

    /**
     * Run this rule the given number of times, for the first matching requests
     */
    times(n: number): MockRuleBuilder {
        this.isComplete = new TimesData(n);
        return this;
    }

    /**
     * Reply to matched with with given status and (optionally) body
     * and headers.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenReply(status: number, data?: string | Buffer, headers?: Headers): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new SimpleHandlerData(status, data, headers)
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
    thenJSON(status: number, data: object, headers: OutgoingHttpHeaders = {}): Promise<MockedEndpoint> {
        const defaultHeaders = { 'Content-Type': 'application/json' };
        merge(defaultHeaders, headers);

        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new SimpleHandlerData(status, JSON.stringify(data), defaultHeaders)
        };

        return this.addRule(rule);
    }

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
     * - `body` (string)
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
        (request: CompletedRequest) => CallbackHandlerResult | Promise<CallbackHandlerResult>
    ): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new CallbackHandlerData(callback)
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
            completionChecker: this.isComplete,
            handler: new StreamHandlerData(status, stream, headers)
        }

        return this.addRule(rule);
    }

    /**
     * Pass matched requests through to their real destination. This works
     * for proxied requests only, direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. The only option currently supported is ignoreHostCertificateErrors,
     * a list of hostnames for which server certificate errors should
     * be ignored (none, by default).
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
            completionChecker: this.isComplete,
            handler: new PassThroughHandlerData(options)
        };

        return this.addRule(rule);
    }

    /**
     * Forward matched requests on to the specified forwardToUrl. The url
     * specified must not include a path. Otherwise, an error is thrown.
     * The path portion of the original request url is used instead.
     *
     * This method also takes options to configure how the request is passed
     * through. The only option currently supported is ignoreHostCertificateErrors,
     * a list of hostnames for which server certificate errors should
     * be ignored (none, by default).
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    async thenForwardTo(forwardToLocation: string, options?: PassThroughHandlerOptions): Promise<MockedEndpoint> {
        const { protocol, hostname, port, path } = url.parse(forwardToLocation);
        if (path && path.trim() !== "/") {
            const suggestion = url.format({ protocol, hostname, port });
            throw new Error(stripIndent`
                URLs passed to thenForwardTo cannot include a path, but "${forwardToLocation}" does. ${''
                }Did you mean ${suggestion}?
            `);
        }

        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new PassThroughHandlerData(defaults({ forwardToLocation }, options))
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
            completionChecker: this.isComplete,
            handler: new CloseConnectionHandlerData()
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
            completionChecker: this.isComplete,
            handler: new TimeoutHandlerData()
        };

        return this.addRule(rule);
    }
}

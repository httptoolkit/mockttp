import { isString } from "lodash";
import { MaybePromise } from "../main";

import { CompletedRequest, Method, RulePriority } from "../types";

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
    HeaderMatcher,
    QueryMatcher,
    MultipartFieldMatchCondition,
    MultipartFormDataMatcher,
    FormDataMatcher,
    RawBodyMatcher,
    RawBodyIncludesMatcher,
    CookieMatcher,
    RegexBodyMatcher,
    JsonBodyMatcher,
    JsonBodyFlexibleMatcher,
    ExactQueryMatcher,
    HostMatcher,
    CallbackMatcher,
    HostnameMatcher,
    PortMatcher,
    ProtocolMatcher,
    RegexUrlMatcher
} from "./matchers";

/**
 * @class BaseRuleBuilder
 *
 * Defines the base matching & completion methods, used for both normal
 * and websocket request handling, but excluding the handling itself
 * which differs between the two cases.
 */
export abstract class BaseRuleBuilder {

    /**
     * Mock rule builders should be constructed through the Mockttp instance you're
     * using, not directly. You shouldn't ever need to call this constructor.
     */
    constructor() {}

    protected matchers: RequestMatcher[] = [];

    private priority: number = RulePriority.DEFAULT;
    private completionChecker?: RuleCompletionChecker;

    protected buildBaseRuleData() {
        return {
            priority: this.priority,
            matchers: this.matchers,
            completionChecker: this.completionChecker
        };
    }

    /**
     * Set the rule priority. Any matching rule with a higher priority will always
     * take precedence over a matching lower-priority rule, unless the higher rule
     * has an explicit completion check (like `.once()`) that has already been
     * completed.
     *
     * The RulePriority enum defines the standard values useful for most cases,
     * but any positive number may be used for advanced configurations.
     *
     * In many cases it may be simpler to use forUnmatchedRequest() to set a fallback
     * rule explicitly, rather than manually setting the priority here.
     */
    asPriority(priority: RulePriority | number): this {
        this.priority = priority;
        return this;
    }

    /**
     * Match only requests sent to the given host, i.e. the full hostname plus
     * port included in the request.
     *
     * This can behave somewhat confusingly when matching against the default
     * ports for a protocol (i.e. 80/443), or when specifying a hostname here
     * without specifying the port. In those cases it's usually better to use
     * forHostname and/or forPort instead to explicit match the content you're
     * interested in.
     *
     * @category Matching
     */
    forHost(host: string): this {
        this.matchers.push(new HostMatcher(host));
        return this;
    }

    /**
     * Match only requests sent to the given hostname, ignoring the port.
     *
     * @category Matching
     */
    forHostname(hostname: string): this {
        this.matchers.push(new HostnameMatcher(hostname));
        return this;
    }

    /**
     * Match only requests sent to the given port.
     *
     * @category Matching
     */
    forPort(port: number): this {
        this.matchers.push(new PortMatcher(port));
        return this;
    }

    /**
     * Match only requests that include the given headers.
     * @category Matching
     */
    withHeaders(headers: { [key: string]: string }): this {
        this.matchers.push(new HeaderMatcher(headers));
        return this;
    }

    /**
     * Match only requests that include the given query parameters.
     * @category Matching
     */
    withQuery(query: { [key: string]: string | number | (string | number)[] }): this {
        this.matchers.push(new QueryMatcher(query));
        return this;
    }

    /**
     * Match only requests that include the exact query string provided.
     * The query string must start with a ? or be entirely empty.
     * @category Matching
     */
    withExactQuery(query: string): this {
        this.matchers.push(new ExactQueryMatcher(query));
        return this;
    }

    /**
     * Match only requests whose bodies include the given URL-encoded form data.
     * @category Matching
     */
    withForm(formData: { [key: string]: string }): this {
        this.matchers.push(new FormDataMatcher(formData));
        return this;
    }

    /**
     * Match only requests whose bodies include the given multipart form data.
     *
     * This can take any number of form parts to look for. Each part is specified
     * with {@link MultipartFieldMatchCondition} object containing one or more of
     * `name` (string), `filename` (string) and `content` (string or buffer) as
     * fields to match against in the form data.
     *
     * Requests are matched if all conditions match at least one part in the
     * request's form data.
     *
     * @category Matching
     */
    withMultipartForm(...matchConditions: Array<MultipartFieldMatchCondition>): this {
        this.matchers.push(new MultipartFormDataMatcher(matchConditions));
        return this;
    }

    /**
     * Match only requests whose bodies either exactly match the given string
     * (if a string is passed) or whose bodies match a regular expression
     * (if a regex is passed).
     * @category Matching
     */
    withBody(content: string | RegExp): this {
        this.matchers.push(
            isString(content)
                ? new RawBodyMatcher(content)
                : new RegexBodyMatcher(content)
        );
        return this;
    }

    /**
     * Match only requests whose bodies include the given string.
     * @category Matching
     */
    withBodyIncluding(content: string): this {
        this.matchers.push(new RawBodyIncludesMatcher(content));
        return this;
    }

    /**
     * Match only requests whose bodies exactly match the given
     * object, when parsed as JSON.
     *
     * Note that this only tests that the body can be parsed
     * as JSON - it doesn't require a content-type header.
     * @category Matching
     */
    withJsonBody(json: {}): this {
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
     * @category Matching
     */
    withJsonBodyIncluding(json: {}): this {
        this.matchers.push(
            new JsonBodyFlexibleMatcher(json)
        );
        return this;
    }

    /**
     * Match only requests that include the given cookies
     * @category Matching
     */
    withCookie(cookie: { [key: string]: string }): this {
        this.matchers.push(new CookieMatcher(cookie));
        return this;
    }

    /**
     * Match only requests sent with the given protocol.
     * @category Matching
     */
    withProtocol(protocol: "http" | "https" | "ws" | "wss"): this {
        this.matchers.push(new ProtocolMatcher(protocol));
        return this;
    }

    /**
     * Match only requests whose absolute url matches the given RegExp.
     * @category Matching
     */
    withUrlMatching(pattern: RegExp): this {
        this.matchers.push(new RegexUrlMatcher(pattern));
        return this;
    }

    /**
     * Match only requests when the callback returns true
     * @category Matching
     */
    matching(
        content: (request: CompletedRequest) => MaybePromise<boolean>
    ): this {
        this.matchers.push(new CallbackMatcher(content));
        return this;
    }

    /**
     * Run this rule forever, for all matching requests
     * @category Completion
     */
    always(): this {
        this.completionChecker = new Always();
        return this;
    }

    /**
     * Run this rule only once, for the first matching request
     * @category Completion
     */
    once(): this {
        this.completionChecker = new Once();
        return this;
    }

    /**
     * Run this rule twice, for the first two matching requests
     * @category Completion
     */
    twice(): this {
        this.completionChecker = new Twice();
        return this;
    }

    /**
     * Run this rule three times, for the first three matching requests
     * @category Completion
     */
    thrice(): this {
        this.completionChecker = new Thrice();
        return this;
    }

    /**
     * Run this rule the given number of times, for the first matching requests
     * @category Completion
     */
    times(n: number): this {
        this.completionChecker = new NTimes(n);
        return this;
    }
}

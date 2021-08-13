import { isString } from "lodash";

import { Method } from "../types";

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
    RawBodyIncludesMatcher,
    WildcardMatcher,
    CookieMatcher,
    RegexBodyMatcher,
    JsonBodyMatcher,
    JsonBodyFlexibleMatcher,
    ExactQueryMatcher,
    HostMatcher
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
    constructor(method?: Method, path?: string | RegExp) {
        if (method === undefined && path === undefined) {
            this.matchers.push(new WildcardMatcher());
            return;
        }

        if (method !== undefined) {
            this.matchers.push(new MethodMatcher(method));
        }

        if (path instanceof RegExp) {
            this.matchers.push(new RegexPathMatcher(path));
        } else if (typeof path === 'string') {
            this.matchers.push(new SimplePathMatcher(path));
        }
    }

    protected matchers: RequestMatcher[] = [];
    protected completionChecker?: RuleCompletionChecker;

    /**
     * Match only requests sent to the given host
     */
    forHost(host: string): this {
        this.matchers.push(new HostMatcher(host));
        return this;
    }

    /**
     * Match only requests that include the given headers.
     */
    withHeaders(headers: { [key: string]: string }): this {
        this.matchers.push(new HeaderMatcher(headers));
        return this;
    }

    /**
     * Match only requests that include the given query parameters.
     */
    withQuery(query: { [key: string]: string | number | (string | number)[] }): this {
        this.matchers.push(new QueryMatcher(query));
        return this;
    }

    /**
     * Match only requests that include the exact query string provided.
     * The query string must start with a ? or be entirely empty.
     */
    withExactQuery(query: string): this {
        this.matchers.push(new ExactQueryMatcher(query));
        return this;
    }

    /**
     * Match only requests whose bodies include the given form data.
     */
    withForm(formData: { [key: string]: string }): this {
        this.matchers.push(new FormDataMatcher(formData));
        return this;
    }

    /**
     * Match only requests whose bodies either exactly match the given string
     * (if a string is passed) or whose bodies match a regular expression
     * (if a regex is passed).
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
     */
    withJsonBodyIncluding(json: {}): this {
        this.matchers.push(
            new JsonBodyFlexibleMatcher(json)
        );
        return this;
    }

    /**
     * Match only requests that include the given cookies
     */
    withCookie(cookie: { [key: string]: string }): this {
        this.matchers.push(new CookieMatcher(cookie));
        return this;
    }

    /**
     * Run this rule forever, for all matching requests
     */
    always(): this {
        this.completionChecker = new Always();
        return this;
    }

    /**
     * Run this rule only once, for the first matching request
     */
    once(): this {
        this.completionChecker = new Once();
        return this;
    }

    /**
     * Run this rule twice, for the first two matching requests
     */
    twice(): this {
        this.completionChecker = new Twice();
        return this;
    }

    /**
     * Run this rule three times, for the first three matching requests
     */
    thrice(): this {
        this.completionChecker = new Thrice();
        return this;
    }

    /**
     * Run this rule the given number of times, for the first matching requests
     */
    times(n: number): this {
        this.completionChecker = new NTimes(n);
        return this;
    }
}

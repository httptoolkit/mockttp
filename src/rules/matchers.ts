/**
 * @module MockRule
 */

import * as _ from 'lodash';
import * as url from 'url';
import { stripIndent } from 'common-tags';

import { OngoingRequest, Method, Explainable } from "../types";
import { Serializable } from "../util/serialization";
import normalizeUrl from "../util/normalize-url";
import { MaybePromise } from '../util/type-utils';

export interface RequestMatcher extends Explainable, Serializable {
    type: keyof typeof MatcherLookup;
    matches(request: OngoingRequest): MaybePromise<boolean>;
}

function unescapeRegexp(input: string): string {
    return input.replace(/\\(.)/g, '$1');
}

export class WildcardMatcher extends Serializable implements RequestMatcher {
    readonly type = 'wildcard';

    matches() {
        return true;
    }

    explain() {
        return 'for anything';
    }
}

export class MethodMatcher extends Serializable implements RequestMatcher {
    readonly type = 'method';

    constructor(
        public method: Method
    ) {
        super();
    }

    matches(request: OngoingRequest) {
        return request.method === Method[this.method];
    }

    explain() {
        return `making ${Method[this.method]}s`;
    }
}

export class SimplePathMatcher extends Serializable implements RequestMatcher {
    readonly type = 'simple-path';

    private normalizedUrl: string;

    constructor(
        public path: string
    ) {
        super();

        let { search, query } = url.parse(this.path, true);
        if (search) {
            throw new Error(stripIndent`
                Tried to match a path that contained a query (${search}). ${''
                }To match query parameters, add .withQuery(${JSON.stringify(query)}) instead.
            `);
        }

        this.normalizedUrl = normalizeUrl(this.path);
    }

    matches(request: OngoingRequest) {
        return request.normalizedUrl === this.normalizedUrl;
    }

    explain() {
        return `for ${this.path}`;
    }
}

export class RegexPathMatcher extends Serializable implements RequestMatcher {
    readonly type = 'regex-path';
    readonly regexString: string;

    constructor(regex: RegExp) {
        super();
        this.regexString = regex.source;
    }

    matches(request: OngoingRequest) {
        let urlMatcher = new RegExp(this.regexString);
        return urlMatcher.test(request.normalizedUrl);
    }

    explain() {
        return `matching /${unescapeRegexp(this.regexString)}/`;
    }
}

export class HeaderMatcher extends Serializable implements RequestMatcher {
    readonly type = 'header';

    public headers: { [key: string]: string };

    constructor(headersInput: { [key: string]: string }) {
        super();
        this.headers = _.mapKeys(headersInput, (_value: string, key: string) => key.toLowerCase());
    }

    matches(request: OngoingRequest) {
        return _.isMatch(request.headers, this.headers);
    }

    explain() {
        return `with headers including ${JSON.stringify(this.headers)}`;
    }
}

export class QueryMatcher extends Serializable implements RequestMatcher {
    readonly type = 'query';

    public queryObject: { [key: string]: string | string[] };

    constructor(
        queryObjectInput: { [key: string]: string | number | (string | number)[] },
    ) {
        super();
        this.queryObject = _.mapValues(queryObjectInput, (v) =>
            Array.isArray(v) ? v.map(av => av.toString()) : v.toString()
        );
    }

    matches(request: OngoingRequest) {
        let { query } = url.parse(request.url, true);
        return _.isMatch(query, this.queryObject);
    }

    explain() {
        return `with a query including ${JSON.stringify(this.queryObject)}`;
    }
}

export class FormDataMatcher extends Serializable implements RequestMatcher {
    readonly type = 'form-data';

    constructor(
        public formData: { [key: string]: string }
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const contentType = request.headers['content-type'];

        return !!contentType &&
            contentType.indexOf("application/x-www-form-urlencoded") !== -1 &&
            _.isMatch(await request.body.asFormData(), this.formData);
    }

    explain() {
        return `with form data including ${JSON.stringify(this.formData)}`;
    }
}

export class RawBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'raw-body';

    constructor(
        public content: string
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        return (await request.body.asText()) === this.content;
    }

    explain() {
        return `with body '${this.content}'`;
    }
}

export class RegexBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'raw-body-regexp';
    readonly regexString: string;

    constructor(regex: RegExp) {
        super();
        this.regexString = regex.source;
    }

    async matches(request: OngoingRequest) {
        let bodyMatcher = new RegExp(this.regexString);
        return bodyMatcher.test(await request.body.asText());
    }

    explain() {
        return `with body matching /${unescapeRegexp(this.regexString)}/`;
    }

}

export class JsonBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'json-body';

    constructor(
        public body: {}
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const receivedBody = await (request.body.asJson().catch(() => undefined));

        if (receivedBody === undefined) return false;
        else return _.isEqual(receivedBody, this.body)
    }

    explain() {
        return `with ${JSON.stringify(this.body)} as a JSON body`;
    }

}

export class JsonBodyFlexibleMatcher extends Serializable implements RequestMatcher {
    readonly type = 'json-body-matching';

    constructor(
        public body: {}
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const receivedBody = await (request.body.asJson().catch(() => undefined));

        if (receivedBody === undefined) return false;
        else return _.isMatch(receivedBody, this.body)
    }

    explain() {
        return `with JSON body including ${JSON.stringify(this.body)}`;
    }

}

export class CookieMatcher extends Serializable implements RequestMatcher {
    readonly type = 'cookie';

    constructor(
        public cookie: { [key: string]: string },
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        if(!request.headers || !request.headers.cookie) {
            return false;
        }

        const cookies = request.headers.cookie.split(';').map(cookie => {
            const [key, value] = cookie.split('=');

            return { [key.trim()]: (value || '').trim()}
        });

        return cookies.some(element => _.isEqual(element, this.cookie));
    }

    explain() {
        return `with cookies including ${JSON.stringify(this.cookie)}`;
    }
}

export const MatcherLookup = {
    'wildcard': WildcardMatcher,
    'method': MethodMatcher,
    'simple-path': SimplePathMatcher,
    'regex-path': RegexPathMatcher,
    'header': HeaderMatcher,
    'query': QueryMatcher,
    'form-data': FormDataMatcher,
    'raw-body': RawBodyMatcher,
    'raw-body-regexp': RegexBodyMatcher,
    'json-body': JsonBodyMatcher,
    'json-body-matching': JsonBodyFlexibleMatcher,
    'cookie': CookieMatcher,
};

export async function matchesAll(req: OngoingRequest, matchers: RequestMatcher[]) {
    return _.every(
        await Promise.all(
            matchers.map((matcher) => matcher.matches(req))
        )
    );
}

export function explainMatchers(matchers: RequestMatcher[]) {
    if (matchers.length === 1) return matchers[0].explain();
    if (matchers.length === 2) {
        // With just two explanations, you can just combine them
        return `${matchers[0].explain()} ${matchers[1].explain()}`;
    }

    // With 3+, we need to oxford comma separate explanations to make them readable
    return matchers.slice(0, -1)
    .map((m) => m.explain())
    .join(', ') + ', and ' + matchers.slice(-1)[0].explain();
}
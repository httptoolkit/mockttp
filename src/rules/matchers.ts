/**
 * @module MockRuleData
 */

import * as _ from 'lodash';
import * as url from 'url';

import { OngoingRequest, Method } from "../types";
import { RequestMatcher } from "./mock-rule-types";
import { MockRule } from "./mock-rule";
import { Serializable } from "../util/serialization";
import normalizeUrl from "../util/normalize-url";
import { stripIndent } from 'common-tags';

export class WildcardMatcherData extends Serializable {
    readonly type: 'wildcard' = 'wildcard';

    buildMatcher() {
        return _.assign(
            () => true,
            { explain: () => 'for anything' }
        );
    }
}

export class MethodMatcherData extends Serializable {
    readonly type: 'method' = 'method';

    constructor(
        public method: Method
    ) {
        super();
    }

    buildMatcher() {
        let methodName = Method[this.method];

        return _.assign((request: OngoingRequest) =>
            request.method === methodName
        , { explain: () => `making ${methodName}s` });
    }
}

export class SimplePathMatcherData extends Serializable {
    readonly type: 'simple-path' = 'simple-path';

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
    }

    buildMatcher() {
        let url = normalizeUrl(this.path);

        return _.assign((request: OngoingRequest) =>
            normalizeUrl(request.url) === url
        , { explain: () => `for ${this.path}` });
    }
}

export class RegexPathMatcherData extends Serializable {
    readonly type: 'regex-path' = 'regex-path';
    readonly regexString: string;

    constructor(regex: RegExp) {
        super();
        this.regexString = regex.source;
    }

    buildMatcher() {
        let url = new RegExp(this.regexString);

        return _.assign((request: OngoingRequest) =>
            url.test(normalizeUrl(request.url))
        , { explain: () => `for paths matching /${this.regexString}/` });
    }
}

export class HeaderMatcherData extends Serializable {
    readonly type: 'header' = 'header';

    constructor(
        public headers: { [key: string]: string },
    ) {
        super();
    }

    buildMatcher() {
        let lowerCasedHeaders = _.mapKeys(this.headers, (_value: string, key: string) => key.toLowerCase());
        return _.assign(
            (request: OngoingRequest) => _.isMatch(request.headers, lowerCasedHeaders)
        , { explain: () => `with headers including ${JSON.stringify(this.headers)}` });
    }
}

export class QueryMatcherData extends Serializable {
    readonly type: 'query' = 'query';

    constructor(
        public queryObject: { [key: string]: string | number },
    ) {
        super();
    }

    buildMatcher() {
        const expectedQuery = _.mapValues(this.queryObject, (v) => v.toString());

        return _.assign(
            (request: OngoingRequest) => {
                let { query } = url.parse(request.url, true);
                return _.isMatch(query, expectedQuery);
            }
        , { explain: () => `with a query including ${JSON.stringify(this.queryObject)}` });
    }
}

export class FormDataMatcherData extends Serializable {
    readonly type: 'form-data' = 'form-data';

    constructor(
        public formData: { [key: string]: string }
    ) {
        super();
    }

    buildMatcher() {
        return _.assign(async (request: OngoingRequest) => {
            const contentType = request.headers['content-type'];

            return !!contentType &&
                contentType.indexOf("application/x-www-form-urlencoded") !== -1 &&
                _.isMatch(await request.body.asFormData(), this.formData)
        }, { explain: () => `with form data including ${JSON.stringify(this.formData)}` });
    }
}

export class RawBodyMatcherData extends Serializable {
    readonly type: 'raw-body' = 'raw-body';

    constructor(
        public content: string
    ) {
        super();
    }

    buildMatcher() {
        return _.assign(async (request: OngoingRequest) =>
            (await request.body.asText()) === this.content
        , { explain: () => `with body '${this.content}'` });
    }
}

export class RegexBodyMatcherData extends Serializable {
    readonly type: 'raw-body-regexp' = 'raw-body-regexp';
    readonly regexString: string;

    constructor(
        public regex: RegExp
    ) {
        super();
        this.regexString = regex.source;
    }

    buildMatcher() {
        let bodyToMatch = new RegExp(this.regexString);

        return _.assign(async (request: OngoingRequest) =>
            bodyToMatch.test(await request.body.asText())
        , { explain: () => `for body matching /${this.regexString}/` });
    }
    
}

export class CookieMatcherData extends Serializable {
    readonly type: 'cookie' = 'cookie';

    constructor(
        public cookie: { [key: string]: string },
    ) {
        super();
    }

    buildMatcher() {
        return _.assign(
            async (request: OngoingRequest) => {
                if(!request.headers || !request.headers.cookie) {
                    return;
                }

                const cookies = request.headers.cookie.split(';').map(cookie => {
                    const [key, value] = cookie.split('=');

                    return { [key.trim()]: (value || '').trim()}
                });

                return cookies.some(element => _.isEqual(element, this.cookie))
            },
            { explain: () => `with cookies including ${JSON.stringify(this.cookie)}` }
        );
    }
}

export type MatcherData = (
    WildcardMatcherData |
    MethodMatcherData |
    SimplePathMatcherData |
    RegexPathMatcherData |
    HeaderMatcherData |
    QueryMatcherData |
    FormDataMatcherData |
    RawBodyMatcherData |
    RegexBodyMatcherData |
    CookieMatcherData
);

export const MatcherDataLookup = {
    'wildcard': WildcardMatcherData,
    'method': MethodMatcherData,
    'simple-path': SimplePathMatcherData,
    'regex-path': RegexPathMatcherData,
    'header': HeaderMatcherData,
    'query': QueryMatcherData,
    'form-data': FormDataMatcherData,
    'raw-body': RawBodyMatcherData,
    'regex-body': RegexBodyMatcherData,
    'cookie': CookieMatcherData,
};

export function buildMatchers(matcherPartData: MatcherData[]): RequestMatcher {
    const matchers = matcherPartData.map(m => m.buildMatcher());

    return _.assign(async function matchRequest(req: OngoingRequest) {
        return _.every(await Promise.all(matchers.map((m) => m(req))));
    }, { explain: function (this: MockRule) {
        if (matchers.length === 1) return matchers[0].explain.apply(this);
        if (matchers.length === 2) {
            // With just two explanations, you can just combine them
            return `${matchers[0].explain.apply(this)} ${matchers[1].explain.apply(this)}`;
        }

        // With 3+, we need to oxford comma separate explanations to make them readable
        return matchers.slice(0, -1)
        .map((m) => <string> m.explain.apply(this))
        .join(', ') + ', and ' + matchers.slice(-1)[0].explain.apply(this);
    } });
}

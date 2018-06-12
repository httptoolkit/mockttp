/**
 * @module MockRuleData
 */

import * as _ from "lodash";

import { OngoingRequest, Method } from "../types";
import { RequestMatcher } from "./mock-rule-types";
import { MockRule } from "./mock-rule";
import normalizeUrl from "../util/normalize-url";

export type MatcherData = (
    WildcardMatcherData |
    MethodMatcherData |
    SimplePathMatcherData |
    RegexPathMatcherData |
    HeaderMatcherData |
    FormDataMatcherData
);

export type MatcherType = MatcherData['type'];

export type MatcherDataLookup = {
    'wildcard': WildcardMatcherData,
    'method': MethodMatcherData,
    'simple-path': SimplePathMatcherData,
    'regex-path': RegexPathMatcherData,
    'header': HeaderMatcherData,
    'form-data': FormDataMatcherData
}

export class WildcardMatcherData {
    readonly type: 'wildcard' = 'wildcard';
}

export class MethodMatcherData {
    readonly type: 'method' = 'method';

    constructor(
        public method: Method
    ) {}
}

export class SimplePathMatcherData {
    readonly type: 'simple-path' = 'simple-path';

    constructor(
        public path: string
    ) {}
}

export class RegexPathMatcherData {
    readonly type: 'regex-path' = 'regex-path';
    readonly regexString: string;

    constructor(regex: RegExp) {
        this.regexString = regex.source;
    }
}

export class HeaderMatcherData {
    readonly type: 'header' = 'header';

    constructor(
        public headers: { [key: string]: string },
    ) {}
}

export class FormDataMatcherData {
    readonly type: 'form-data' = 'form-data';

    constructor(
        public formData: { [key: string]: string }
    ) {}
}

export function buildMatchers(matcherPartData: MatcherData[]): RequestMatcher {
    const matchers = matcherPartData.map(buildMatcher);

    return _.assign(async function matchRequest(req: OngoingRequest) {
        return _.every(await Promise.all(matchers.map((m) => m(req))));
    }, { explain: function (this: MockRule) {
        if (matchers.length === 1) return matchers[0].explain.apply(this);

        // Oxford comma separate our matcher explanations
        return matchers.slice(0, -1)
        .map((m) => <string> m.explain.apply(this))
        .join(', ') + ', and ' + matchers.slice(-1)[0].explain.apply(this);
    } });
}

export function buildMatcher
    <T extends MatcherType, D extends MatcherDataLookup[T]>
    (matcherPartData: D): RequestMatcher
{
    // Neither of these casts should really be required imo, seem like TS bugs
    const type = <T> matcherPartData.type;
    const builder = <MatcherBuilder<D>> matcherBuilders[type];
    return builder(matcherPartData);
}

type MatcherBuilder<D extends MatcherData> = (data: D) => RequestMatcher

const matcherBuilders: { [T in MatcherType]: MatcherBuilder<MatcherDataLookup[T]> } = {
    wildcard: (): RequestMatcher => {
        return _.assign(() => true, { explain: () => 'for anything' })
    },

    method: (data: MethodMatcherData): RequestMatcher => {
        let methodName = Method[data.method];

        return _.assign((request: OngoingRequest) =>
            request.method === methodName
        , { explain: () => `making ${methodName}s` });
    },

    'simple-path': (data: SimplePathMatcherData): RequestMatcher => {
        let url = normalizeUrl(data.path);

        return _.assign((request: OngoingRequest) =>
            normalizeUrl(request.url) === url
        , { explain: () => `for ${data.path}` });
    },

    'regex-path': (data: RegexPathMatcherData): RequestMatcher => {
        let url = new RegExp(data.regexString);

        return _.assign((request: OngoingRequest) =>
            url.test(normalizeUrl(request.url))
        , { explain: () => `for paths matching /${data.regexString}/` });
    },

    header: (data: HeaderMatcherData): RequestMatcher => {
        let lowerCasedHeaders = _.mapKeys(data.headers, (value: string, key: string) => key.toLowerCase());
        return _.assign(
            (request: OngoingRequest) => _.isMatch(request.headers, lowerCasedHeaders)
        , { explain: () => `with headers including ${JSON.stringify(data.headers)}` });
    },

    'form-data': (data: FormDataMatcherData): RequestMatcher => {
        return _.assign(async (request: OngoingRequest) =>
            !!request.headers["content-type"] &&
            request.headers["content-type"].indexOf("application/x-www-form-urlencoded") !== -1 &&
            _.isMatch(await request.body.asFormData(), data.formData)
        , { explain: () => `with form data including ${JSON.stringify(data.formData)}` });
    }
};

function combineMatchers(matcherA: RequestMatcher, matcherB: RequestMatcher): RequestMatcher {
    return _.assign(
        (request: OngoingRequest) => matcherA(request) && matcherB(request),
        { explain: function (this: MockRule) {
            return `${matcherA.explain.apply(this)} and ${matcherB.explain.apply(this)}`;
        } }
    );
};
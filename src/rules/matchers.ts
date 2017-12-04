import * as _ from "lodash";

import { OngoingRequest, Method } from "../types";
import { RequestMatcher } from "./mock-rule-types";
import { MockRule } from "./mock-rule";
import normalizeUrl from "../util/normalize-url";

export type MatcherData = (
    SimpleMatcherData |
    HeaderMatcherData |
    FormDataMatcherData
);

export type MatcherType = MatcherData['type'];

export type MatcherDataLookup = {
    'simple': SimpleMatcherData,
    'header': HeaderMatcherData,
    'form-data': FormDataMatcherData
}

export class SimpleMatcherData {
    readonly type: 'simple' = 'simple';

    constructor(
        public method: Method,
        public path: string
    ) {}
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
    simple: (data: SimpleMatcherData): RequestMatcher => {
        let methodName = Method[data.method];
        let url = normalizeUrl(data.path);

        return _.assign((request: OngoingRequest) =>
            request.method === methodName && normalizeUrl(request.url) === url
        , { explain: () => `making ${methodName}s for ${data.path}` });
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
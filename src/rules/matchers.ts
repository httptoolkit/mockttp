import * as _ from "lodash";

import { Request, Method } from "../types";
import { RequestMatcher } from "./mock-rule-types";
import { MockRule } from "./mock-rule";

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
    readonly type = 'simple';

    constructor(
        public method: Method,
        public path: string
    ) {}
}

export class HeaderMatcherData {
    readonly type = 'header';

    constructor(
        public headers: { [key: string]: string },
    ) {}
}

export class FormDataMatcherData {
    readonly type = 'form-data';

    constructor(
        public formData: { [key: string]: string }
    ) {}
}

export function buildMatchers(matcherPartData: MatcherData[]): RequestMatcher {
    const matchers = matcherPartData.map(buildMatcher);

    const matchRequest = <RequestMatcher> function matchRequest(req: Request) {
        return _.every(matchers, (m) => m(req));
    }

    matchRequest.explain = function (this: MockRule) {
        if (matchers.length === 1) return matchers[0].explain.apply(this);

        // Oxford comma separate our matcher explanations
        return matchers.slice(0, -1)
        .map((m) => <string> m.explain.apply(this))
        .join(', ') + ', and ' + matchers.slice(-1)[0].explain.apply(this);
    }

    return matchRequest;
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
        let matcher = <RequestMatcher> ((request: Request) =>
            request.method === methodName && request.url === data.path
        );
        matcher.explain = () => `making ${methodName}s for ${data.path}`;
        return matcher;
    },

    header: (data: HeaderMatcherData): RequestMatcher => {
        let lowerCasedHeaders = _.mapKeys(data.headers, (value: string, key: string) => key.toLowerCase());
        let matcher = <RequestMatcher> ((request) =>
            _.isMatch(request.headers, lowerCasedHeaders)
        );
        matcher.explain = () => `with headers including ${JSON.stringify(data.headers)}`;
        return matcher;
    },

    'form-data': (data: FormDataMatcherData): RequestMatcher => {
        let matcher = <RequestMatcher> ((request) =>
            request.headers["content-type"] &&
            request.headers["content-type"].indexOf("application/x-www-form-urlencoded") !== -1 &&
            _.isMatch(request.body, data.formData)
        );
        matcher.explain = () => `with form data including ${JSON.stringify(data.formData)}`;
        return matcher;
    }
};

function combineMatchers(matcherA: RequestMatcher, matcherB: RequestMatcher): RequestMatcher {
    let matcher = <RequestMatcher> ((request) => matcherA(request) && matcherB(request));
    matcher.explain = function (this: MockRule) {
        return `${matcherA.explain.apply(this)} and ${matcherB.explain.apply(this)}`;
    }
    return matcher;
};
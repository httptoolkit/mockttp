import express = require("express");
import _ = require("lodash");
import uuid = require("uuid/v1");

import { Method, Request } from "../types";
import { MockRule, RequestMatcher, RequestHandler, RuleCompletionChecker, MockedEndpoint } from "./mock-rule-types";
import {
    always,
    once,
    twice,
    thrice,
    times
} from './completion-checkers';

export default class PartialMockRule {
    constructor(method: Method, path: string, private addRule: (rule: MockRule) => void) {
        this.matcher = simpleMatcher(method, path);
    }

    private matcher: RequestMatcher;
    private isComplete?: RuleCompletionChecker;

    withHeaders(headers: { [key: string]: string }) {
        this.matcher = combineMatchers(this.matcher, headersMatcher(headers));
        return this;
    }

    withForm(formData: { [key: string]: string }): PartialMockRule {
        this.matcher = combineMatchers(this.matcher, formDataMatcher(formData));
        return this;
    }

    always(): PartialMockRule {
        this.isComplete = always;
        return this;
    }

    once(): PartialMockRule {
        this.isComplete = once;
        return this;
    }

    twice(): PartialMockRule {
        this.isComplete = twice;
        return this;
    }

    thrice(): PartialMockRule {
        this.isComplete = thrice;
        return this;
    }

    times(n: number): PartialMockRule {
        this.isComplete = times(n);
        return this;
    }

    thenReply(status: number, data?: string): Promise<MockedEndpoint> {
        const explain = () => {
            let explanation = `Match requests ${rule.matches.explain()}, and then ${rule.handleRequest.explain()}`;
            if (this.isComplete) {
                explanation += `, ${this.isComplete.explain()}.`;
            }
            return explanation;
        }

        const id = uuid();

        const endpoint = {
            id,
            getSeenRequests: () => Promise.resolve<Request[]>(_.clone(rule.requests))
        };

        const rule: MockRule = {
            id,
            matches: this.matcher,
            handleRequest: wrapHandler(
                (request) => rule.requests.push(request),
                simpleResponder(status, data)
            ),
            isComplete: this.isComplete,
            explain: explain,

            requests: [],
            getMockedEndpoint: () => endpoint
        };

        this.addRule(rule);

        return Promise.resolve(rule.getMockedEndpoint());
    }
}

function combineMatchers(matcherA: RequestMatcher, matcherB: RequestMatcher): RequestMatcher {
    let matcher = <RequestMatcher> ((request) => matcherA(request) && matcherB(request));
    matcher.explain = () => `${matcherA.explain()} and ${matcherB.explain()}`;
    return matcher;
}

function simpleMatcher(method: Method, path: string): RequestMatcher {
    let methodName = Method[method];
    let matcher = <RequestMatcher> ((request: Request) =>
        request.method === methodName && request.url === path
    );
    matcher.explain = () => `making ${methodName}s for ${path}`;
    return matcher;
}

function headersMatcher(headers: { [key: string]: string }): RequestMatcher {
    let lowerCasedHeaders = _.mapKeys(headers, (value: string, key: string) => key.toLowerCase());
    let matcher = <RequestMatcher> ((request) =>
        _.isMatch(request.headers, lowerCasedHeaders)
    );
    matcher.explain = () => `with headers including ${JSON.stringify(headers)}`;
    return matcher;
}

function formDataMatcher(formData: { [key: string]: string }): RequestMatcher {
    let matcher = <RequestMatcher> ((request) =>
        request.headers["content-type"] &&
        request.headers["content-type"].indexOf("application/x-www-form-urlencoded") !== -1 &&
        _.isMatch(request.body, formData)
    );
    matcher.explain = () => `with form data including ${JSON.stringify(formData)}`;
    return matcher;
}

function simpleResponder(status: number, data?: string): RequestHandler {
    let responder = <RequestHandler> async function(request: Request, response: express.Response) {
        response.writeHead(status);
        response.end(data || "");
    }
    responder.explain = () => `respond with status ${status}` + (data ? ` and body "${data}"` : "");
    return responder;
}

function wrapHandler(beforeHook: (request: Request) => void, handler: RequestHandler): RequestHandler {
    let wrappedHandler = <RequestHandler> ((request: Request, response: express.Response) => {
        beforeHook(request);
        return handler(request, response);
    });
    wrappedHandler.explain = handler.explain;
    return wrappedHandler;
}

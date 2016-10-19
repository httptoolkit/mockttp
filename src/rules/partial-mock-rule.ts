import express = require("express");
import _ = require("lodash");

import { Method, Request } from "../common-types";
import { MockRule, RequestMatcher, RequestHandler, RuleCompletionChecker } from "./mock-rule-types";

export default class PartialMockRule {
    constructor(private addRule: (rule: MockRule) => void, method: Method, path: string) {
        this.matcher = simpleMatcher(method, path);
    }

    private matcher: RequestMatcher;

    withForm(formData: { [key: string]: string }): PartialMockRule {
        this.matcher = combineMatchers(this.matcher, formDataMatcher(formData));
        return this;
    }

    thenReply(status: number, data?: string): MockRule {
        let completionHandler = triggerOnce();

        let rule = {
            matches: this.matcher,
            handleRequest: completionHandler.wrap(simpleResponder(status, data)), // TODO: Should wrap whole rule?
            isComplete: completionHandler,
            explain: () => `Match requests ${rule.matches.explain()} and ${rule.handleRequest.explain()}, ${completionHandler.explain()}.`
        }
        this.addRule(rule);
        return rule;
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

function triggerOnce(): RuleCompletionChecker {
    let callCount = 0;
    let isComplete = <RuleCompletionChecker> (() => callCount > 0);

    isComplete.wrap = (handler: RequestHandler) => {
        let wrappedHandler = <RequestHandler> ((request: Request, response: express.Response) => {
            callCount += 1;
            return handler(request, response);
        });
        wrappedHandler.explain = handler.explain;
        return wrappedHandler;
    };

    isComplete.explain = () => "once";

    return isComplete;
}

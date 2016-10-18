import http = require("http");

import { Method } from "../common-types";
import { MockRule, RequestMatcher, RequestHandler, RuleCompletionChecker } from "./mock-rule-types";

export default class PartialMockRule {
    constructor(private addRule: (rule: MockRule) => void, method: Method, path: string) {
        this.matcher = simpleMatcher(method, path);
    }

    private matcher: RequestMatcher;

    thenReply(status: number, data: string): MockRule {
        let completionHandler = triggerOnce();

        let rule = {
            matches: this.matcher,
            handleRequest: completionHandler.wrap(simpleResponder(status, data)), // TODO: Should wrap whole rule?
            isComplete: completionHandler,
            explain: () => `${rule.matches.explain()} and ${rule.handleRequest.explain()}, ${completionHandler.explain()}.`
        }
        this.addRule(rule);
        return rule;
    }
}

function simpleMatcher(method: Method, path: string): RequestMatcher {
    let methodName = Method[method];
    let matcher = <RequestMatcher> ((request: http.IncomingMessage) =>
        request.method === methodName && request.url === path
    );
    matcher.explain = () => `Match ${methodName} requests for ${path}`;
    return matcher;
}

function simpleResponder(status: number, data: string): RequestHandler {
    let responder = <RequestHandler> async function(request: http.IncomingMessage, response: http.ServerResponse) {
        response.writeHead(status);
        response.end(data);
    }
    responder.explain = () => `respond with status ${status} and body "${data}"`;
    return responder;
}

function triggerOnce(): RuleCompletionChecker {
    let callCount = 0;
    let isComplete = <RuleCompletionChecker> (() => callCount > 0);

    isComplete.wrap = (handler: RequestHandler) => {
        let wrappedHandler = <RequestHandler> ((request: http.IncomingMessage, response: http.ServerResponse) => {
            callCount += 1;
            return handler(request, response);
        });
        wrappedHandler.explain = handler.explain;
        return wrappedHandler;
    };

    isComplete.explain = () => "once";

    return isComplete;
}

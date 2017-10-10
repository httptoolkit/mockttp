import uuid = require("uuid/v4");
import * as _ from "lodash";

import { Request, Response } from "../types";
import {
  MockRule as MockRuleInterface,
  RuleExplainable,
  RuleCompletionChecker,
  RequestHandler,
  RequestMatcher,
  MockRuleData
} from "./mock-rule-types";
import { buildMatchers, MatcherData } from "./matchers";
import { HandlerData, buildHandler } from "./handlers";
import {
  CompletionCheckerData,
  buildCompletionChecker
} from "./completion-checkers";

export function serializeRuleData(data: MockRuleData) {
    return {
        matchers: data.matchers,
        handler: data.handler,
        completionChecker: data.completionChecker
    }
};

export class MockRule implements MockRuleInterface {
    public matches: RequestMatcher;
    public isComplete?: RuleCompletionChecker;
    public handleRequest: RequestHandler;

    public id: string = uuid();
    public requests: Request[] = [];

    constructor({
        matchers,
        handler,
        completionChecker
    }: MockRuleData) {
        this.matches = buildMatchers(matchers);
        this.handleRequest = this.recordRequests(buildHandler(handler));
        this.isComplete = buildCompletionChecker(completionChecker);
    }

    // Wrap the handler, to add the request to this.requests when it's done
    private recordRequests(handler: RequestHandler): RequestHandler {
        const thisRule = this;
        const recordRequest = <RequestHandler> function recordRequest(this: any, req: Request, res: Response) {
            return handler.apply(this, arguments).then(() => thisRule.requests.push(req));
        }
        recordRequest.explain = handler.explain;
        return recordRequest;
    }

    explain(): string {
        let explanation = `Match requests ${this.matches.explain.apply(this)}, ` +
        `and then ${this.handleRequest.explain.apply(this)}`;

        if (this.isComplete) {
            explanation += `, ${this.isComplete.explain.apply(this)}.`;
        } else {
            explanation += '.';
        }

        return explanation;
    }
}
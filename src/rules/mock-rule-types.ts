/**
 * @module MockRule
 */

import { Explainable, OngoingRequest, CompletedRequest, Response, Method } from "../types";
import { MatcherData } from "./matchers";
import { CompletionCheckerData } from "./completion-checkers";
import { HandlerData } from "./handlers";

// The internal representation of the mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    matches: RequestMatcher;
    handleRequest: RequestHandler;
    isComplete?: RuleCompletionChecker;

    requests: Promise<CompletedRequest>[];
}

export interface MockRuleData {
    matchers: MatcherData[];
    handler: HandlerData
    completionChecker?: CompletionCheckerData;
}

export interface RuleExplainable extends Explainable {
    explain(this: MockRule): string;
}

export interface RequestMatcher extends RuleExplainable {
    (request: OngoingRequest): boolean | Promise<boolean>;
}

export interface RequestHandler extends RuleExplainable {
    (request: OngoingRequest, response: Response): Promise<void>
}

export interface RuleCompletionChecker extends RuleExplainable {
    (this: MockRule): boolean;
}

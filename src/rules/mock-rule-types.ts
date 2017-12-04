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

export type RequestMatcher = ((request: OngoingRequest) => boolean | Promise<boolean>) & RuleExplainable;
export type RequestHandler = ((request: OngoingRequest, response: Response) => Promise<void>) & RuleExplainable;

export interface RuleCompletionChecker extends RuleExplainable {
    (this: MockRule): boolean;
}

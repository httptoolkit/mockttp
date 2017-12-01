import { Explainable, Request, Response, Method } from "../types";
import { MatcherData } from "./matchers";
import { CompletionCheckerData } from "./completion-checkers";
import { HandlerData } from "./handlers";

// The internal representation of the mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    matches: RequestMatcher;
    handleRequest: RequestHandler;
    isComplete?: RuleCompletionChecker;

    requests: Request[];
}

export interface MockRuleData {
    matchers: MatcherData[];
    handler: HandlerData
    completionChecker?: CompletionCheckerData;
}

export interface RuleExplainable extends Explainable {
    explain(this: MockRule): string;
}

export type RequestMatcher = ((request: Request) => boolean) & RuleExplainable;
export type RequestHandler = ((request: Request, response: Response) => Promise<void>) & RuleExplainable;

export interface RuleCompletionChecker extends RuleExplainable {
    (this: MockRule): boolean;
}

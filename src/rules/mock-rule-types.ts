import express = require("express");
import { Explainable, Request } from "../common-types";

export interface MockRule extends Explainable {
    matches: RequestMatcher
    handleRequest: RequestHandler;
    isComplete?: RuleCompletionChecker;

    readonly requestCount: number;
    requests: Request[];
}

export type RequestMatcher = ((request: Request) => boolean) & Explainable;
export type RequestHandler = ((request: Request, response: express.Response) => Promise<void>) & Explainable;

export interface RuleCompletionChecker extends Explainable {
    (this: MockRule): boolean;
}

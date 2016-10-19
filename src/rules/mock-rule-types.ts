import express = require("express");
import { Explainable, Request } from "../common-types";

export interface MockRule extends Explainable {
    matches: RequestMatcher
    handleRequest: RequestHandler;
    isComplete: RuleCompletionChecker;
}

export type RequestMatcher = ((request: Request) => boolean) & Explainable;
export type RequestHandler = ((request: Request, response: express.Response) => Promise<void>) & Explainable;

export interface RuleCompletionChecker extends Explainable {
    (): boolean;
    wrap(handler: RequestHandler): RequestHandler;
}

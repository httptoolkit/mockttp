import http = require("http");
import { Explainable } from "../common-types";

export interface MockRule extends Explainable {
    matches: RequestMatcher
    handleRequest: RequestHandler;
    isComplete: RuleCompletionChecker;
}

export type RequestMatcher = ((request: http.IncomingMessage) => boolean) & Explainable;
export type RequestHandler = ((request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>) & Explainable;

export interface RuleCompletionChecker extends Explainable {
    (): boolean;
    wrap(handler: RequestHandler): RequestHandler;
}

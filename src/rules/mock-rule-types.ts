/**
 * @module MockRule
 */

import { Explainable, OngoingRequest, CompletedRequest, OngoingResponse } from "../types";
import { Serializable } from "../util/serialization";

// The internal representation of a mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these because MockRule is not serializable
    matches(request: OngoingRequest): boolean | Promise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
    isComplete(): boolean | null;
}

export interface MockRuleData {
    matchers: RequestMatcher[];
    handler: RequestHandler
    completionChecker?: RuleCompletionChecker;
}

export interface RequestMatcher extends Explainable, Serializable {
    matches(request: OngoingRequest): boolean | Promise<boolean>;
}

export interface RequestHandler extends Explainable, Serializable {
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
}

export interface RuleCompletionChecker extends Serializable {
    isComplete(seenRequests: Promise<CompletedRequest>[]): boolean;
    explain(seenRequests: Promise<CompletedRequest>[]): string;
}

/**
 * @module MockRule
 */

import { Explainable, OngoingRequest, CompletedRequest, OngoingResponse } from "../types";
import { Serializable } from "../util/serialization";
import { MaybePromise } from "../util/type-utils";

// The internal representation of a mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these because MockRule is not serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse, record: boolean): Promise<void>;
    isComplete(): boolean | null;
}

export interface MockRuleData {
    matchers: RequestMatcher[];
    handler: RequestHandler
    completionChecker?: RuleCompletionChecker;
}

export interface RequestMatcher extends Explainable, Serializable {
    matches(request: OngoingRequest): MaybePromise<boolean>;
}

export interface RequestHandler extends Explainable, Serializable {
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
}

export interface RuleCompletionChecker extends Serializable {
    isComplete(seenRequestCount: number): boolean;
    explain(seenRequestCount: number): string;
}

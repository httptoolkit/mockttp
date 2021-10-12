import * as _ from 'lodash';
import uuid = require("uuid/v4");

import { OngoingRequest, CompletedRequest, OngoingResponse, Explainable } from "../../types";
import { waitForCompletedRequest } from '../../util/request-utils';
import { MaybePromise } from '../../util/type-utils';

import * as matchers from "../matchers";
import * as handlers from "./request-handlers";
import * as completionCheckers from "../completion-checkers";
import { validateMockRuleData } from '../rule-serialization';

// The internal representation of a mocked endpoint
export interface RequestRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these, because MockRules are not Serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse, record: boolean): Promise<void>;
    isComplete(): boolean | null;
}

export interface RequestRuleData {
    id?: string;
    matchers: matchers.RequestMatcher[];
    handler: handlers.RequestHandler;
    completionChecker?: completionCheckers.RuleCompletionChecker;
}

export class RequestRule implements RequestRule {
    private matchers: matchers.RequestMatcher[];
    private handler: handlers.RequestHandler;
    private completionChecker?: completionCheckers.RuleCompletionChecker;

    public id: string;
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: RequestRuleData) {
        validateMockRuleData(data);

        this.id = data.id || uuid();
        this.matchers = data.matchers;
        this.handler = data.handler;
        this.completionChecker = data.completionChecker;
    }

    matches(request: OngoingRequest) {
        return matchers.matchesAll(request, this.matchers);
    }

    handle(req: OngoingRequest, res: OngoingResponse, record: boolean): Promise<void> {
        let handlerPromise = (async () => { // Catch (a)sync errors
            return this.handler.handle(req, res);
        })();

        // Requests are added to rule.requests as soon as they start being handled,
        // as promises, which resolve only when the response & request body is complete.
        if (record) {
            this.requests.push(
                Promise.race([
                    // When the handler resolves, the request is completed:
                    handlerPromise,
                    // If the response is closed before the handler completes (due to aborts, handler
                    // timeouts, whatever) then that also counts as the request being completed:
                    new Promise((resolve) => res.on('close', resolve))
                ])
                .catch(() => {}) // Ignore handler errors here - we're only tracking the request
                .then(() => waitForCompletedRequest(req))
            );
        }

        // Even if traffic recording is disabled, the number of matched
        // requests is still tracked
        this.requestCount += 1;

        return handlerPromise as Promise<any>;
    }

    isComplete(): boolean | null {
        if (this.completionChecker) {
            // If we have a specific rule, use that
            return this.completionChecker.isComplete(this.requestCount);
        } else if (this.requestCount === 0) {
            // Otherwise, by default we're definitely incomplete if we've seen no requests
            return false;
        } else {
            // And we're _maybe_ complete if we've seen at least one request. In reality, we're incomplete
            // but we should be used anyway if we're at any point we're the last matching rule for a request.
            return null;
        }
    }

    explain(withoutExactCompletion = false): string {
        let explanation = `Match requests ${matchers.explainMatchers(this.matchers)}, ` +
        `and then ${this.handler.explain()}`;

        if (this.completionChecker) {
            explanation += `, ${this.completionChecker.explain(
                withoutExactCompletion ? undefined : this.requestCount
            )}.`;
        } else {
            explanation += '.';
        }

        return explanation;
    }

    dispose() {
        this.handler.dispose();
        this.matchers.forEach(m => m.dispose());
        if (this.completionChecker) this.completionChecker.dispose();
    }
}
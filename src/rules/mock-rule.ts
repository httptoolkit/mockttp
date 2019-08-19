/**
 * @module MockRule
 */

import * as _ from 'lodash';
import uuid = require("uuid/v4");
import { Duplex } from 'stream';

import { OngoingRequest, CompletedRequest, OngoingResponse, Explainable } from "../types";
import { deserialize, serialize,  Serialized } from '../util/serialization';
import { waitForCompletedRequest } from '../util/request-utils';
import { MaybePromise } from '../util/type-utils';

import * as matchers from "./matchers";
import * as handlers from "./handlers";
import * as completionCheckers from "./completion-checkers";

function validateMockRuleData(data: MockRuleData): void {
    if (!data.matchers || data.matchers.length === 0) {
        throw new Error('Cannot create a rule without at least one matcher');
    }
    if (!data.handler) {
        throw new Error('Cannot create a rule with no handler');
    }
}

// The internal representation of a mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these, because MockRules are not Serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse, record: boolean): Promise<void>;
    isComplete(): boolean | null;
}

export interface MockRuleData {
    id?: string;
    matchers: matchers.RequestMatcher[];
    handler: handlers.RequestHandler;
    completionChecker?: completionCheckers.RuleCompletionChecker;
}

export function serializeRuleData(data: MockRuleData, stream: Duplex): Serialized<MockRuleData> {
    validateMockRuleData(data);

    return {
        id: data.id,
        matchers: data.matchers.map(m => serialize(m, stream)),
        handler: serialize(data.handler, stream),
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    };
};

export function deserializeRuleData(data: Serialized<MockRuleData>, stream: Duplex): MockRuleData {
    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, handlers.HandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            completionCheckers.CompletionCheckerLookup
        )
    };
}

export class MockRule implements MockRule {
    private matchers: matchers.RequestMatcher[];
    private handler: handlers.RequestHandler;
    private completionChecker?: completionCheckers.RuleCompletionChecker;

    public id: string;
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: MockRuleData) {
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
        let completedPromise = (async () => {
            await this.handler.handle(req, res);
            return waitForCompletedRequest(req);
        })();

        // Requests are added to rule.requests as soon as they start being handled,
        // as promises, which resolve when the response is complete.
        if (record) {
            this.requests.push(completedPromise);
        }

        // Even if traffic recording is disabled, the number of matched
        // requests is still tracked
        this.requestCount += 1;

        return completedPromise as Promise<any>;
    }

    isComplete(): boolean | null {
        if (this.completionChecker) {
            return this.completionChecker.isComplete(this.requestCount);
        } else {
            return null;
        }
    }

    explain(): string {
        let explanation = `Match requests ${matchers.explainMatchers(this.matchers)}, ` +
        `and then ${this.handler.explain()}`;

        if (this.completionChecker) {
            explanation += `, ${this.completionChecker.explain(this.requestCount)}.`;
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
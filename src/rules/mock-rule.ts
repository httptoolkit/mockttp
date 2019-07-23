/**
 * @module MockRule
 */

import * as _ from 'lodash';
import uuid = require("uuid/v4");
import { Duplex } from 'stream';

import { deserialize, serialize,  Serialized } from '../util/serialization';
import { waitForCompletedRequest } from '../server/request-utils';

import { OngoingRequest, CompletedRequest, OngoingResponse } from "../types";
import {
  MockRule as MockRuleInterface,
  RuleCompletionChecker,
  RequestHandler,
  RequestMatcher,
  MockRuleData
} from "./mock-rule-types";

import * as matching from "./matchers";
import * as handling from "./handlers";
import * as completion from "./completion-checkers";

function validateMockRuleData(data: MockRuleData): void {
    if (!data.matchers || data.matchers.length === 0) {
        throw new Error('Cannot create a rule without at least one matcher');
    }
    if (!data.handler) {
        throw new Error('Cannot create a rule with no handler');
    }
}

export function serializeRuleData(data: MockRuleData, stream: Duplex): Serialized<MockRuleData> {
    validateMockRuleData(data);

    return {
        matchers: data.matchers.map(m => serialize(m, stream)),
        handler: serialize(data.handler, stream),
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    }
};

export function deserializeRuleData(data: Serialized<MockRuleData>, stream: Duplex): MockRuleData {
    return {
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, matching.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, handling.HandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            completion.CompletionCheckerLookup
        )
    };
}

export class MockRule implements MockRuleInterface {
    private matchers: RequestMatcher[];
    private handler: RequestHandler;
    private completionChecker?: RuleCompletionChecker;

    public id: string = uuid();
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: MockRuleData) {
        validateMockRuleData(data);

        this.matchers = data.matchers;
        this.handler = data.handler;
        this.completionChecker = data.completionChecker;
    }

    matches(request: OngoingRequest) {
        return matching.matchesAll(request, this.matchers);
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
        let explanation = `Match requests ${matching.explainMatchers(this.matchers)}, ` +
        `and then ${this.handler.explain()}`;

        if (this.completionChecker) {
            explanation += `, ${this.completionChecker.explain(this.requestCount)}.`;
        } else {
            explanation += '.';
        }

        return explanation;
    }
}
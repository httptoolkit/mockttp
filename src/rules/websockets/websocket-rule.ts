import * as _ from 'lodash';
import { v4 as uuid } from "uuid";
import * as net from 'net';
import * as http from 'http';

import {
    OngoingRequest,
    CompletedRequest,
    Explainable,
    RulePriority
} from "../../types";
import { waitForCompletedRequest } from '../../util/request-utils';
import { MaybePromise } from '@httptoolkit/util';

import { validateMockRuleData } from '../rule-serialization';

import * as matchers from "../matchers";
import * as completionCheckers from "../completion-checkers";
import { WebSocketStep, WsStepLookup } from "./websocket-steps";
import type { WebSocketStepDefinition } from "./websocket-step-definitions";

// The internal representation of a mocked endpoint
export interface WebSocketRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these, because MockRules are not Serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(
        request: OngoingRequest,
        response: net.Socket,
        head: Buffer,
        options: {
            record: boolean,
            emitEventCallback?: (type: string, event: unknown) => void
        }
    ): Promise<void>;
    isComplete(): boolean | null;
}

export interface WebSocketRuleData {
    id?: string;
    priority?: number; // Higher is higher, by default 0 is fallback, 1 is normal, must be positive
    matchers: matchers.RequestMatcher[];
    steps: Array<WebSocketStep | WebSocketStepDefinition>;
    completionChecker?: completionCheckers.RuleCompletionChecker;
}

export class WebSocketRule implements WebSocketRule {
    private matchers: matchers.RequestMatcher[];
    private steps: WebSocketStep[];
    private completionChecker?: completionCheckers.RuleCompletionChecker;

    public id: string;
    public readonly priority: number;
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: WebSocketRuleData) {
        validateMockRuleData(data);

        this.id = data.id || uuid();
        this.priority = data.priority ?? RulePriority.DEFAULT;
        this.matchers = data.matchers;
        this.completionChecker = data.completionChecker;

        this.steps = data.steps.map((stepDefinition, i) => {
            const step = 'handle' in stepDefinition
                ? stepDefinition
                : Object.assign(
                    Object.create(WsStepLookup[stepDefinition.type].prototype),
                    stepDefinition
                ) as WebSocketStep;

            if (WsStepLookup[step.type].isFinal && i !== data.steps.length - 1) {
                throw new Error(
                    `Cannot create a rule with a final step before the last position ("${
                        step.explain()
                    }" in position ${i + 1} of ${data.steps.length})`
                );
            }

            return step;
        });
    }

    matches(request: OngoingRequest) {
        return matchers.matchesAll(request, this.matchers);
    }

    handle(
        req: OngoingRequest,
        res: net.Socket,
        head: Buffer,
        options: {
            record: boolean,
            emitEventCallback?: (type: string, event: unknown) => void
        }
    ): Promise<void> {
        let stepsPromise = (async () => {
            for (let step of this.steps) {
                const result = await step.handle(req as OngoingRequest & http.IncomingMessage, res, head, options);

                if (!result || result.continue === false) break;
            }
        })();

        // Requests are added to rule.requests as soon as they start being handled,
        // as promises, which resolve only when the response & request body is complete.
        if (options.record) {
            this.requests.push(
                Promise.race([
                    // When the handler resolves, the request is completed:
                    stepsPromise,
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

        return stepsPromise as Promise<any>;
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
        let explanation = `Match websockets ${matchers.explainMatchers(this.matchers)}, ` +
        `and then ${explainSteps(this.steps)}`;

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
        this.steps.forEach(s => s.dispose());
        this.matchers.forEach(m => m.dispose());
        if (this.completionChecker) this.completionChecker.dispose();
    }
}

export function explainSteps(steps: WebSocketStepDefinition[]) {
    if (steps.length === 1) return steps[0].explain();
    if (steps.length === 2) {
        return `${steps[0].explain()} then ${steps[1].explain()}`;
    }

    // With 3+, we need to oxford comma separate explanations to make them readable
    return steps.slice(0, -1)
        .map((s) => s.explain())
        .join(', ') + ', and ' + steps.slice(-1)[0].explain();
}
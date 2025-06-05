import * as _ from 'lodash';
import { v4 as uuid } from "uuid";

import { OngoingRequest, CompletedRequest, OngoingResponse, Explainable, RulePriority } from "../../types";
import { buildBodyReader, buildInitiatedRequest, waitForCompletedRequest } from '../../util/request-utils';
import { MaybePromise } from '@httptoolkit/util';

import * as matchers from "../matchers";
import { type RequestStepDefinition } from "./request-step-definitions";
import { StepLookup, RequestStep } from "./request-steps";
import * as completionCheckers from "../completion-checkers";
import { validateMockRuleData } from '../rule-serialization';

// The internal representation of a mocked endpoint
export interface RequestRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these, because MockRules are not Serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse, options: {
        record: boolean,
        emitEventCallback?: (type: string, event: unknown) => void
    }): Promise<void>;
    isComplete(): boolean | null;
}

export interface RequestRuleData {
    id?: string;
    priority?: number; // Higher is higher, by default 0 is fallback, 1 is normal, must be positive
    matchers: matchers.RequestMatcher[];
    steps: Array<RequestStep | RequestStepDefinition>;
    completionChecker?: completionCheckers.RuleCompletionChecker;
}

export class RequestRule implements RequestRule {
    private matchers: matchers.RequestMatcher[];
    private steps: Array<RequestStep>;
    private completionChecker?: completionCheckers.RuleCompletionChecker;

    public id: string;
    public readonly priority: number;
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: RequestRuleData) {
        validateMockRuleData(data);

        this.id = data.id || uuid();
        this.priority = data.priority ?? RulePriority.DEFAULT;
        this.matchers = data.matchers;
        this.completionChecker = data.completionChecker;

        this.steps = data.steps.map((stepDefinition, i) => {
            const step = 'handle' in stepDefinition
                ? stepDefinition
                : Object.assign(
                    Object.create(StepLookup[stepDefinition.type].prototype),
                    stepDefinition
                ) as RequestStep;

            if (StepLookup[step.type].isFinal && i !== data.steps.length - 1) {
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

    handle(req: OngoingRequest, res: OngoingResponse, options: {
        record?: boolean,
        emitEventCallback?: (type: string, event: unknown) => void
    }): Promise<void> {
        let stepsPromise = (async () => {
            for (let step of this.steps) {
                const result = await step.handle(req, res, {
                    emitEventCallback: options.emitEventCallback
                });

                if (!result || result.continue === false) break;
            }
        })();

        // Requests are added to rule.requests as soon as they start being handled,
        // as promises, which resolve only when the response & request body is complete.
        if (options.record) {
            this.requests.push(
                Promise.race([
                    // When the steps all resolve, the request is completed:
                    stepsPromise,
                    // If the response is closed before the step completes (due to aborts, step
                    // timeouts, whatever) then that also counts as the request being completed:
                    new Promise((resolve) => res.on('close', resolve))
                ])
                .catch(() => {}) // Ignore step errors here - we're only tracking the request
                .then(() => waitForCompletedRequest(req))
                .catch((): CompletedRequest => {
                    // If for some reason the request is not completed, we still want to record it.
                    // TODO: Update the body to return the data that has been received so far.
                    const initiatedRequest = buildInitiatedRequest(req);
                    return {
                        ...initiatedRequest,
                        body: buildBodyReader(Buffer.from([]), req.headers),
                        rawTrailers: [],
                        trailers: {}
                    };
                })
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
        let explanation = `Match requests ${matchers.explainMatchers(this.matchers)}, ` +
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

export function explainSteps(steps: RequestStepDefinition[]) {
    if (steps.length === 1) return steps[0].explain();
    if (steps.length === 2) {
        return `${steps[0].explain()} then ${steps[1].explain()}`;
    }

    // With 3+, we need to oxford comma separate explanations to make them readable
    return steps.slice(0, -1)
        .map((s) => s.explain())
        .join(', ') + ', and ' + steps.slice(-1)[0].explain();
}
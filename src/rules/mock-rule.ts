import uuid = require("uuid/v4");
import * as _ from "lodash";

import { OngoingRequest, CompletedRequest, Response } from "../types";
import {
  MockRule as MockRuleInterface,
  RuleExplainable,
  RuleCompletionChecker,
  RequestHandler,
  RequestMatcher,
  MockRuleData
} from "./mock-rule-types";

import * as matching from "./matchers";
import * as handling from "./handlers";
import * as completion from "./completion-checkers";

export function serializeRuleData(data: MockRuleData) {
    return {
        matchers: data.matchers,
        handler: data.handler,
        completionChecker: data.completionChecker
    }
};

export class MockRule implements MockRuleInterface {
    public matches: RequestMatcher;
    public isComplete?: RuleCompletionChecker;
    public handleRequest: RequestHandler;

    public id: string = uuid();
    public requests: Promise<CompletedRequest>[] = [];

    constructor({
        matchers,
        handler,
        completionChecker
    }: MockRuleData) {
        this.matches = matching.buildMatchers(matchers);
        this.handleRequest = this.recordRequests(handling.buildHandler(handler));
        this.isComplete = completion.buildCompletionChecker(completionChecker);
    }

    // Wrap the handler, to add the request to this.requests when it's done
    private recordRequests(handler: RequestHandler): RequestHandler {
        const thisRule = this;

        const recordRequest = <RequestHandler> function recordRequest(this: any, req: OngoingRequest, res: Response) {
            const handlerArgs = arguments;
            let completedAndRecordedPromise = (async (resolve, reject) => {
                await handler.apply(this, handlerArgs);

                let result = _(req).pick([
                    'protocol',
                    'method',
                    'url',
                    'hostname',
                    'path',
                    'headers'
                ]).assign({
                    body: {
                        buffer: await req.body.asBuffer(),
                        text: await req.body.asText().catch(() => undefined),
                        json: await req.body.asJson().catch(() => undefined),
                        formData: await req.body.asFormData().catch(() => undefined)
                    }
                }).valueOf();

                return result;
            })();
            
            // Requests are added to rule.requests as soon as they start being handled.
            thisRule.requests.push(completedAndRecordedPromise);

            return completedAndRecordedPromise.then(() => {});
        };

        recordRequest.explain = handler.explain;
        return recordRequest;
    }

    explain(): string {
        let explanation = `Match requests ${this.matches.explain.apply(this)}, ` +
        `and then ${this.handleRequest.explain.apply(this)}`;

        if (this.isComplete) {
            explanation += `, ${this.isComplete.explain.apply(this)}.`;
        } else {
            explanation += '.';
        }

        return explanation;
    }
}
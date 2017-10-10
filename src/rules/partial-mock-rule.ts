import { Method, Request, MockedEndpoint } from "../types";

import {
    MockRuleData
} from "./mock-rule-types";

import {
    CompletionCheckerData,
    AlwaysData,
    TimesData,
    ThriceData,
    TwiceData,
    OnceData
} from "./completion-checkers";

import {
    SimpleMatcherData,
    MatcherData,
    HeaderMatcherData,
    FormDataMatcherData
} from "./matchers";

import { SimpleHandlerData } from "./handlers";

/**
 * Fluently builds mock rule data, passing it to the initial
 * callback once it's built & complete, and returning the (eventually)
 * defined endpoint to the consuming code once it's been registered
 */
export default class PartialMockRule {
    constructor(
        method: Method,
        path: string,
        private addRule: (rule: MockRuleData) => Promise<MockedEndpoint>)
    {
        this.matchers = [new SimpleMatcherData(method, path)];
    }

    private matchers: MatcherData[];
    private isComplete?: CompletionCheckerData;

    withHeaders(headers: { [key: string]: string }) {
        this.matchers.push(new HeaderMatcherData(headers));
        return this;
    }

    withForm(formData: { [key: string]: string }): PartialMockRule {
        this.matchers.push(new FormDataMatcherData(formData));
        return this;
    }

    always(): PartialMockRule {
        this.isComplete = new AlwaysData();
        return this;
    }

    once(): PartialMockRule {
        this.isComplete = new OnceData();
        return this;
    }

    twice(): PartialMockRule {
        this.isComplete = new TwiceData();
        return this;
    }

    thrice(): PartialMockRule {
        this.isComplete = new ThriceData();
        return this;
    }

    times(n: number): PartialMockRule {
        this.isComplete = new TimesData(n);
        return this;
    }

    thenReply(status: number, data?: string): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new SimpleHandlerData(status, data)
        };

        return this.addRule(rule);
    }
}
/**
 * @module MockRule
 */

import { Method, MockedEndpoint } from "../types";

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
    FormDataMatcherData,
    WildcardMatcherData
} from "./matchers";

import { SimpleHandlerData, PassThroughHandlerData } from "./handlers";
import { OutgoingHttpHeaders } from "http";

/**
 * Fluently builds mock rule data, passing it to the initial
 * callback once it's built & complete, and returning the (eventually)
 * defined endpoint to the consuming code once it's been registered
 */
export default class MockRuleBuilder {
    private addRule: (rule: MockRuleData) => Promise<MockedEndpoint>;

    constructor(addRule: (rule: MockRuleData) => Promise<MockedEndpoint>)
    constructor(
        method: Method,
        path: string,
        addRule: (rule: MockRuleData) => Promise<MockedEndpoint>
    )
    constructor(
        methodOrAddRule: Method | ((rule: MockRuleData) => Promise<MockedEndpoint>),
        path?: string,
        addRule?: (rule: MockRuleData) => Promise<MockedEndpoint>
    ) {
        if (methodOrAddRule instanceof Function) {
            this.matchers.push(new WildcardMatcherData());
            this.addRule = methodOrAddRule;
        } else {
            this.matchers.push(new SimpleMatcherData(methodOrAddRule, path!));
            this.addRule = addRule!;
        }
    }

    private matchers: MatcherData[] = [];
    private isComplete?: CompletionCheckerData;

    withHeaders(headers: { [key: string]: string }) {
        this.matchers.push(new HeaderMatcherData(headers));
        return this;
    }

    withForm(formData: { [key: string]: string }): MockRuleBuilder {
        this.matchers.push(new FormDataMatcherData(formData));
        return this;
    }

    always(): MockRuleBuilder {
        this.isComplete = new AlwaysData();
        return this;
    }

    once(): MockRuleBuilder {
        this.isComplete = new OnceData();
        return this;
    }

    twice(): MockRuleBuilder {
        this.isComplete = new TwiceData();
        return this;
    }

    thrice(): MockRuleBuilder {
        this.isComplete = new ThriceData();
        return this;
    }

    times(n: number): MockRuleBuilder {
        this.isComplete = new TimesData(n);
        return this;
    }

    thenReply(status: number, data?: string, headers?: OutgoingHttpHeaders): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new SimpleHandlerData(status, data, headers)
        };

        return this.addRule(rule);
    }

    thenPassThrough(): Promise<MockedEndpoint> {
        const rule: MockRuleData = {
            matchers: this.matchers,
            completionChecker: this.isComplete,
            handler: new PassThroughHandlerData()
        };

        return this.addRule(rule);
    }
}
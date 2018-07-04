/**
 * @module MockRuleData
 */

import { RuleCompletionChecker, MockRule, RuleExplainable } from './mock-rule-types';
import { Serializable } from '../util/serialization';

export class AlwaysData extends Serializable {
    readonly type: 'always' = 'always';

    buildCompletionChecker() {
        return withExplanation(
            () => false,
            function (this: MockRule) {
                return explainUntil(this.requests, Infinity, 'always');
            }
        );
    }
}

export class OnceData extends Serializable {
    readonly type: 'once' = 'once';

    buildCompletionChecker() {
        return withExplanation(
            checkTimes(1),
            function (this: MockRule) {
                return explainUntil(this.requests, 1, 'once');
            }
        );
    }
}

export class TwiceData extends Serializable {
    readonly type: 'twice' = 'twice';

    buildCompletionChecker() {
        return withExplanation(
            checkTimes(2),
            function (this: MockRule) {
                return explainUntil(this.requests, 2, 'twice');
            }
        )
    }
}

export class ThriceData extends Serializable {
    readonly type: 'thrice' = 'thrice';

    buildCompletionChecker() {
        return withExplanation(
            checkTimes(3),
            function (this: MockRule) {
                return explainUntil(this.requests, 3, 'thrice');
            }
        )
    }
}

export class TimesData extends Serializable {
    readonly type: 'times' = 'times';
    
    constructor(public count: number) {
        super();
    }

    buildCompletionChecker() {
        let count = this.count;

        return withExplanation(
            checkTimes(count),
            function (this: MockRule) {
                return explainUntil(this.requests, count, `${count} times`);
            }
        )
    }
}

export type CompletionCheckerData = (
    AlwaysData |
    OnceData |
    TwiceData |
    ThriceData |
    TimesData
)

export const CompletionCheckerDataLookup = {
    'always': AlwaysData,
    'once': OnceData,
    'twice': TwiceData,
    'thrice': ThriceData,
    'times': TimesData
}

export function buildCompletionChecker(data?: CompletionCheckerData): RuleCompletionChecker | undefined {
    if (data) {
        return data.buildCompletionChecker();
    } else {
        return undefined;
    }
}

function checkTimes(n: number): () => boolean {
    return function (this: MockRule) {
        return this.requests.length >= n;
    }
}

function explainUntil(requests: {}[], n: number, name: string): string {
    const seen = requests.length;
    return name + " " + (seen < n ? `(seen ${seen})` : "(done)");
}

function withExplanation<T extends Function>(
    functionToExplain: T,
    explainer: (this: MockRule) => string
): T & RuleExplainable {
    (<T & RuleExplainable> functionToExplain).explain = explainer;
    return <T & RuleExplainable> functionToExplain;
}
import { RuleCompletionChecker, MockRule } from './mock-rule-types';
import { Explainable } from "../common-types";

export var always: RuleCompletionChecker = withExplanation(
    () => false,
    () => 'always'
);

function checkTimes(n: number): () => boolean {
    return function (this: MockRule) {
        return this.callCount >= n;
    }
}

export var once: RuleCompletionChecker = withExplanation(
    checkTimes(1),
    () => 'once'
);

export var twice: RuleCompletionChecker = withExplanation(
    checkTimes(2),
    () => 'twice'
);

export var thrice: RuleCompletionChecker = withExplanation(
    checkTimes(3),
    () => 'thrice'
);

export var times = (n: number): RuleCompletionChecker => withExplanation(
    checkTimes(n),
    () => `${n} times`
);

function withExplanation<T extends Function>(
    functionToExplain: T,
    explainer: (this: MockRule) => string
): T & Explainable {
    (<T & Explainable> functionToExplain).explain = explainer;
    return <T & Explainable> functionToExplain;
}
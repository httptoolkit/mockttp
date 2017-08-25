import { RuleCompletionChecker, MockRule, RuleExplainable } from './mock-rule-types';

export var always: RuleCompletionChecker = withExplanation(
    () => false,
    function (this: MockRule) {
        return explainUntil(this.requests, Infinity, 'always');
    }
);

function checkTimes(n: number): () => boolean {
    return function (this: MockRule) {
        return this.requests.length >= n;
    }
}

function explainUntil(requests: {}[], n: number, name: string): string {
    const seen = requests.length;
    return name + " " + (seen < n ? `(seen ${seen})` : "(done)");
}

export var once: RuleCompletionChecker = withExplanation(
    checkTimes(1),
    function (this: MockRule) {
        return explainUntil(this.requests, 1, 'once');
    }
);

export var twice: RuleCompletionChecker = withExplanation(
    checkTimes(2),
    function (this: MockRule) {
        return explainUntil(this.requests, 2, 'twice');
    }
);

export var thrice: RuleCompletionChecker = withExplanation(
    checkTimes(3),
    function (this: MockRule) {
        return explainUntil(this.requests, 3, 'thrice');
    }
);

export var times = (n: number): RuleCompletionChecker => withExplanation(
    checkTimes(n),
    function (this: MockRule) {
        return explainUntil(this.requests, n, `${n} times`);
    }
);

function withExplanation<T extends Function>(
    functionToExplain: T,
    explainer: (this: MockRule) => string
): T & RuleExplainable {
    (<T & RuleExplainable> functionToExplain).explain = explainer;
    return <T & RuleExplainable> functionToExplain;
}
import { RuleCompletionChecker, MockRule, RuleExplainable } from './mock-rule-types';

export type CompletionCheckerData = (
    AlwaysData |
    OnceData |
    TwiceData |
    ThriceData |
    TimesData
)

export type CompletionCheckerType = CompletionCheckerData['type'];

export type CompletionCheckerDataLookup = {
    'always': AlwaysData,
    'once': OnceData,
    'twice': TwiceData,
    'thrice': ThriceData,
    'times': TimesData
}

export class AlwaysData {
    readonly type: 'always' = 'always';
    constructor() {}
}

export class OnceData {
    readonly type: 'once' = 'once';
    constructor() {}
}

export class TwiceData {
    readonly type: 'twice' = 'twice';
    constructor() {}
}

export class ThriceData {
    readonly type: 'thrice' = 'thrice';
    constructor() {}
}

export class TimesData {
    readonly type: 'times' = 'times';
    constructor(public count: number) { }
}

type CompletionCheckerBuilder<D extends CompletionCheckerData> = (data: D) => RuleCompletionChecker;

export function buildCompletionChecker
    <T extends CompletionCheckerType, D extends CompletionCheckerDataLookup[T]>
    (completionCheckerData?: D): RuleCompletionChecker | undefined
{
    if (!completionCheckerData) return;

    // Neither of these casts should really be required imo, seem like TS bugs
    const type = <T> completionCheckerData.type;
    const builder = <CompletionCheckerBuilder<D>> completionCheckerBuilders[type];
    return builder(completionCheckerData);
}

const completionCheckerBuilders: { [T in CompletionCheckerType]: CompletionCheckerBuilder<CompletionCheckerDataLookup[T]> } = {
    'always': () => withExplanation(
        () => false,
        function (this: MockRule) {
            return explainUntil(this.requests, Infinity, 'always');
        }
    ),
    'once': () => withExplanation(
        checkTimes(1),
        function (this: MockRule) {
            return explainUntil(this.requests, 1, 'once');
        }
    ),
    'twice': () => withExplanation(
        checkTimes(2),
        function (this: MockRule) {
            return explainUntil(this.requests, 2, 'twice');
        }
    ),
    'thrice': () => withExplanation(
        checkTimes(3),
        function (this: MockRule) {
            return explainUntil(this.requests, 3, 'thrice');
        }
    ),
    'times': ({ count }: TimesData) => withExplanation(
        checkTimes(count),
        function (this: MockRule) {
            return explainUntil(this.requests, count, `${count} times`);
        }
    )
};

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
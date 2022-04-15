import { Serializable } from '../serialization/serialization';

export interface RuleCompletionChecker extends Serializable {
    type: keyof typeof CompletionCheckerLookup;
    isComplete(seenRequestCount: number): boolean;
    explain(seenRequestCount: number | undefined): string;
}

export class Always extends Serializable implements RuleCompletionChecker {
    readonly type = 'always';

    isComplete() {
        return false;
    }

    explain(seenRequestCount: number | undefined) {
        return explainUntil(seenRequestCount, Infinity, 'always');
    }
}

export class Once extends Serializable implements RuleCompletionChecker {
    readonly type = 'once';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 1;
    }

    explain(seenRequestCount: number | undefined) {
        return explainUntil(seenRequestCount, 1, 'once');
    }
}

export class Twice extends Serializable implements RuleCompletionChecker {
    readonly type = 'twice';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 2;
    }

    explain(seenRequestCount: number | undefined) {
        return explainUntil(seenRequestCount, 2, 'twice');
    }
}

export class Thrice extends Serializable implements RuleCompletionChecker {
    readonly type = 'thrice';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 3;
    }

    explain(seenRequestCount: number | undefined) {
        return explainUntil(seenRequestCount, 3, 'thrice');
    }
}

export class NTimes extends Serializable implements RuleCompletionChecker {
    readonly type = 'times';

    constructor(
        public count: number
    ) {
        super();
    }

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= this.count;
    }

    explain(seenRequestCount: number | undefined) {
        return explainUntil(seenRequestCount, this.count, `${this.count} times`);
    }
}

export const CompletionCheckerLookup = {
    'always': Always,
    'once': Once,
    'twice': Twice,
    'thrice': Thrice,
    'times': NTimes
}

function explainUntil(seen: number | undefined, n: number, name: string): string {
    if (seen === undefined) {
        // Generic explainer, without the specific count
        return name;
    } else {
        return name + " " + (seen < n ? `(seen ${seen})` : "(done)");
    }
}
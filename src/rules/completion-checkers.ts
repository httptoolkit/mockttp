/**
 * @module MockRule
 */

import { CompletedRequest } from '../types';
import { RuleCompletionChecker } from './mock-rule-types';
import { Serializable } from '../util/serialization';

abstract class SerializableCompletionChecker extends Serializable implements RuleCompletionChecker {
    abstract isComplete(seenRequestCount: number): boolean;
    abstract explain(seenRequestCount: number): string;
}

export class Always extends SerializableCompletionChecker {
    readonly type: 'always' = 'always';

    isComplete() {
        return false;
    }

    explain(seenRequestCount: number) {
        return explainUntil(seenRequestCount, Infinity, 'always');
    }
}

export class Once extends SerializableCompletionChecker {
    readonly type: 'once' = 'once';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 1;
    }

    explain(seenRequestCount: number) {
        return explainUntil(seenRequestCount, 1, 'once');
    }
}

export class Twice extends SerializableCompletionChecker {
    readonly type: 'twice' = 'twice';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 2;
    }

    explain(seenRequestCount: number) {
        return explainUntil(seenRequestCount, 2, 'twice');
    }
}

export class Thrice extends SerializableCompletionChecker {
    readonly type: 'thrice' = 'thrice';

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= 3;
    }

    explain(seenRequestCount: number) {
        return explainUntil(seenRequestCount, 3, 'thrice');
    }
}

export class NTimes extends SerializableCompletionChecker {
    readonly type: 'times' = 'times';

    constructor(
        public count: number
    ) {
        super();
    }

    isComplete(seenRequestCount: number) {
        return seenRequestCount >= this.count;
    }

    explain(seenRequestCount: number) {
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

function explainUntil(seen: number, n: number, name: string): string {
    return name + " " + (seen < n ? `(seen ${seen})` : "(done)");
}
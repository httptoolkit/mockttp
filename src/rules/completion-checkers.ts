/**
 * @module MockRule
 */

import { CompletedRequest } from '../types';
import { RuleCompletionChecker } from './mock-rule-types';
import { Serializable } from '../util/serialization';

abstract class SerializableCompletionChecker extends Serializable implements RuleCompletionChecker {
    abstract isComplete(seenRequests: Promise<CompletedRequest>[]): boolean;
    abstract explain(seenRequests: Promise<CompletedRequest>[]): string;
}

export class Always extends SerializableCompletionChecker {
    readonly type: 'always' = 'always';

    isComplete() {
        return false;
    }

    explain(seenRequests: Promise<CompletedRequest>[]) {
        return explainUntil(seenRequests, Infinity, 'always');
    }
}

export class Once extends SerializableCompletionChecker {
    readonly type: 'once' = 'once';

    isComplete(seenRequests: Promise<CompletedRequest>[]) {
        return seenRequests.length >= 1;
    }

    explain(seenRequests: Promise<CompletedRequest>[]) {
        return explainUntil(seenRequests, 1, 'once');
    }
}

export class Twice extends SerializableCompletionChecker {
    readonly type: 'twice' = 'twice';

    isComplete(seenRequests: Promise<CompletedRequest>[]) {
        return seenRequests.length >= 2;
    }

    explain(seenRequests: Promise<CompletedRequest>[]) {
        return explainUntil(seenRequests, 2, 'twice');
    }
}

export class Thrice extends SerializableCompletionChecker {
    readonly type: 'thrice' = 'thrice';

    isComplete(seenRequests: Promise<CompletedRequest>[]) {
        return seenRequests.length >= 3;
    }

    explain(seenRequests: Promise<CompletedRequest>[]) {
        return explainUntil(seenRequests, 3, 'thrice');
    }
}

export class NTimes extends SerializableCompletionChecker {
    readonly type: 'times' = 'times';

    constructor(
        public count: number
    ) {
        super();
    }

    isComplete(seenRequests: Promise<CompletedRequest>[]) {
        return seenRequests.length >= this.count;
    }

    explain(seenRequests: Promise<CompletedRequest>[]) {
        return explainUntil(seenRequests, this.count, `${this.count} times`);
    }
}

export const CompletionCheckerLookup = {
    'always': Always,
    'once': Once,
    'twice': Twice,
    'thrice': Thrice,
    'times': NTimes
}

function explainUntil(requests: {}[], n: number, name: string): string {
    const seen = requests.length;
    return name + " " + (seen < n ? `(seen ${seen})` : "(done)");
}
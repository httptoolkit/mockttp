import * as util from 'util';

import type { CompletedRequest, MockedEndpoint } from '../types';
import type { RequestRule } from '../rules/requests/request-rule';
import type { WebSocketRule } from '../rules/websockets/websocket-rule';

export class ServerMockedEndpoint implements MockedEndpoint {

    constructor(private rule: RequestRule | WebSocketRule) {
        this.getSeenRequests.bind(this);
    };

    get id() {
        return this.rule.id;
    }

    getSeenRequests(): Promise<CompletedRequest[]> {
        // Wait for all completed running requests to have all their details available
        return Promise.all<CompletedRequest>(this.rule.requests);
    }

    async isPending(): Promise<boolean> {
        // We don't actually need to wait for rule.requests to complete, because
        // completion rules right now only check requestCount, and that is always
        // updated synchronously when handling starts.

        const ruleCompletion = this.rule.isComplete();
        if (ruleCompletion !== null) {
            // If the rule has a specific completion value, use it
            return !ruleCompletion;
        } else {
            // If not, then it's default "at least one" completion:
            return this.rule.requestCount === 0;
        }
    }

    [util.inspect.custom]() {
        return "Mocked endpoint: " + this.toString();
    }

    toString(withoutExactCompletion = false) {
        return this.rule.explain(withoutExactCompletion);
    }
}
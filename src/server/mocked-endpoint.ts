/**
 * @module Mockttp
 */

import { CompletedRequest, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';

export class MockedEndpoint implements MockedEndpointInterface {

    constructor (private rule: MockRule) {
        this.getSeenRequests.bind(this);
    };

    get id() {
        return this.rule.id;
    }

    getSeenRequests(): Promise<CompletedRequest[]> {
        // Wait for all completed running requests to have all their details available
        return Promise.all<CompletedRequest>(this.rule.requests);
    }
}
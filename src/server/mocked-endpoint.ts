import { CompletedRequest, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';
import * as _ from "lodash";

export class MockedEndpoint implements MockedEndpointInterface {

    constructor (private rule: MockRule) {
        this.getSeenRequests.bind(this);
    };

    get id() {
        return this.rule.id;
    }

    getSeenRequests(): Promise<CompletedRequest[]> {
        return Promise.resolve<CompletedRequest[]>(_.clone(this.rule.requests))
    }
}
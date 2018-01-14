import { Request, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';
import * as _ from "lodash";

export class MockedEndpoint implements MockedEndpointInterface {

    constructor (private rule: MockRule) { };

    get id() {
        return this.rule.id;
    }

    getSeenRequests = (): Promise<Request[]> => {
        return Promise.resolve<Request[]>(_.clone(this.rule.requests))
    }

    getSeenRequestsBasic(): object[] {
        var data = [];
        for (var request of this.rule.requests) {
            data.push({
                url: request.url,
                method: request.method
            })
        }
        return data;
    }
}
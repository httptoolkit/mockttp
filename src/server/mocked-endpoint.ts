import { Request, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';
import * as _ from "lodash";

interface Data {
    [key: string]: [{
        url: string,
        method: string
    }]
}

export class MockedEndpoint implements MockedEndpointInterface {

    constructor (private rule: MockRule) { };

    get id() {
        return this.rule.id;
    }

    getSeenRequests = (): Promise<Request[]> => {
        return Promise.resolve<Request[]>(_.clone(this.rule.requests))
    }

    getSeenRequestsBasic(): object {
        var data: Data = {};
        for (var request of this.rule.requests) {
            if (!data.hasOwnProperty(request.path)) {
                data[request.path] = [{
                    url: request.url,
                    method: request.method
                }];
            } else {
                data[request.path].push({
                    url: request.url,
                    method: request.method
                });
            }
        }
        return data;
    }
}
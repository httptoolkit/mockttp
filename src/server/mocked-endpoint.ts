import { Request, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';
import * as _ from "lodash";
var URL = require('url-parse');

export interface Data {
    path: string,
    url?: string,
    method?: string
}

export class MockedEndpoint implements MockedEndpointInterface {

    constructor(private rule: MockRule) { };

    get id() {
        return this.rule.id;
    }

    getSeenRequests = (): Promise<Request[]> => {
        return Promise.resolve<Request[]>(_.clone(this.rule.requests))
    }

    getSeenRequestsBasic(): Data[] {
        var data = [];
        if (this.rule.requests.length === 0) {
            var url = new URL(this.rule.explain().split('for ')[1].split(','));
            data.push({
                path: url.pathname
            });
            return data;
        }

        for (var request of this.rule.requests) {
            data.push({
                path: request.path,
                url: request.url,
                method: request.method
            });
        }
        return data;
    }
}
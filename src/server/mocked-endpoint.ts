import { Request, MockedEndpoint as MockedEndpointInterface } from '../types';
import { MockRule } from '../rules/mock-rule';
import * as _ from "lodash";

export class MockedEndpoint implements MockedEndpointInterface {

    constructor(private rule: MockRule) { };

    get id() {
        return this.rule.id;
    }

    getSeenRequests = (): Promise<Request[]> => {
        return Promise.resolve<Request[]>(_.clone(this.rule.requests))
    }

    pendingMocks(): string[] {
        var data = [];
        if (this.rule.requests.length === 0) {
            var url = this.rule.explain().split('for ')[1].split(',')[0];
            var method = this.resolveMethod(this.rule.explain());
            data.push(`${method} ${url}`);
        }
        return data;
    }

    resolveMethod(str: string) {
        if (str.indexOf('GET') > -1) return 'GET';
        if (str.indexOf('POST') > -1) return 'POST';
        if (str.indexOf('PUT') > -1) return 'PUT';
        if (str.indexOf('DELETE') > -1) return 'DELETE';
        if (str.indexOf('PATCH') > -1) return 'PATCH';
        if (str.indexOf('OPTIONS') > -1) return 'OPTIONS';
    }
}
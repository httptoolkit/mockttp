import HttpServerMockServer from "../http-server-mock-server";
import { Method, Request } from "../types";
import { MockedEndpoint } from "../rules/mock-rule-types";

export interface MockRuleInput {
    matcher: {
        method: 'get' | 'post' | 'put',
        url: string
    },
    completionChecker: 'always' | 'once' | 'twice' | 'thrice',
    response: {
        status: number,
        body?: string
    }
}

export interface MockedEndpointOutput {
    id: string,
    seenRequests: Request[]
}

function addRule(
    mockServer: HttpServerMockServer,
    { matcher, completionChecker, response }: MockRuleInput
): Promise<MockedEndpoint> {
    let rule = mockServer[matcher.method](matcher.url);
    return rule[completionChecker]().thenReply(response.status, response.body);
}

async function formatEndpointOutput(endpoint: MockedEndpoint): Promise<MockedEndpointOutput> {
    return {
        id: endpoint.id,
        seenRequests: (await endpoint.getSeenRequests()).map((request) => {
            request.body = JSON.stringify(request.body);
            return request;
        })
    };
}

export class StandaloneModel {
    constructor(
        private mockServer: HttpServerMockServer
    ) { }

    mockedEndpoints() {
        return this.mockServer.mockedEndpoints.map(formatEndpointOutput);
    }

    addRule({ input }: { input: MockRuleInput }) {
        return addRule(this.mockServer, input).then(formatEndpointOutput)
    }

    reset() {
        this.mockServer.reset();
        return true;
    }

    urlFor ({ path }: { path: string }) {
        return this.mockServer.urlFor(path);
    }
}
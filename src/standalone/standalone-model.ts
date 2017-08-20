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

interface MockedEndpointOutput {
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
        seenRequests: await endpoint.getSeenRequests()
    };
}

export class StandaloneModel {
    constructor(private mockServer: HttpServerMockServer) { }

    mockedEndpoints() {
        this.mockServer.mockedEndpoints.map(formatEndpointOutput)
    }

    addRule({ input }: { input: MockRuleInput }) {
        addRule(this.mockServer, input).then(formatEndpointOutput)
    }

    reset() {
        this.mockServer.reset();
        return true;
    }

    urlFor({ path }: { path: string }) {
        this.mockServer.urlFor(path);
    }
}
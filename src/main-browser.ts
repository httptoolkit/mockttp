import HttpServerMockClient from "./client/http-server-mock-client";

import { HttpServerMock } from "./http-server-mock";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): HttpServerMock {
    return new HttpServerMockClient();
}

export function getRemote(): HttpServerMock {
    return new HttpServerMockClient();
}

export function getStandalone(options: any = {}): never {
    throw new Error('Cannot set up a standalone server within a browser');
}
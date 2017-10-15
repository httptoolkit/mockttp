import HttpServerMockServer from "./server/http-server-mock-server";
import HttpServerMockClient from "./client/http-server-mock-client";
import { HttpServerMockStandalone, StandaloneServerOptions } from "./standalone/http-server-mock-standalone";

import { HttpServerMock } from "./http-server-mock-types";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): HttpServerMock {
    return new HttpServerMockServer();
}

export function getRemote(): HttpServerMock {
    return new HttpServerMockClient();
}

export function getStandalone(options: StandaloneServerOptions = {}): HttpServerMockStandalone {
    return new HttpServerMockStandalone(options);
}
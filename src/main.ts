import HttpServerMockServer from "./http-server-mock-server";
import { HttpServerMockStandalone } from "./standalone/http-server-mock-standalone";

import { HttpServerMock } from "./http-server-mock-types";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): HttpServerMock {
    return new HttpServerMockServer();
}

export function getStandalone(): HttpServerMockStandalone {
    return new HttpServerMockStandalone();
}
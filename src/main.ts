import HttpServerMockServer from "./http-server-mock-server";

import { HttpServerMock } from "./http-server-mock-types";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): HttpServerMock {
    return new HttpServerMockServer();
}
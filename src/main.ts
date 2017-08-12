import HttpServerMockServer from "./http-server-mock-server";
export { Request } from "./types";

export var MockServer = HttpServerMockServer;

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}
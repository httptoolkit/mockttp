import HttpServerMock from "./http-server-mock";
export { Request } from "./types";

export var MockServer = HttpServerMock;

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}
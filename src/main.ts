import HttpServerMock from "./http-server-mock";
import { Request } from "./types";

export var MockServer = HttpServerMock;

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}
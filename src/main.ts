import MockttpServer, { MockServerOptions } from "./server/mockttp-server";
import MockttpClient from "./client/mockttp-client";
import { MockttpStandalone, StandaloneServerOptions } from "./standalone/mockttp-standalone";

import { Mockttp } from "./mockttp";
export { OngoingRequest, CompletedRequest } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export { Mockttp };

export function getLocal(options: MockServerOptions = {}): Mockttp {
    return new MockttpServer(options);
}

export function getRemote(options: MockServerOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getStandalone(options: StandaloneServerOptions = {}): MockttpStandalone {
    return new MockttpStandalone(options);
}
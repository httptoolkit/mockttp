/**
 * @module Mockttp
 */

import MockttpServer from "./server/mockttp-server";
import MockttpClient from "./client/mockttp-client";
import { MockttpStandalone, StandaloneServerOptions } from "./standalone/mockttp-standalone";

import { Mockttp, MockttpOptions } from "./mockttp";
export { OngoingRequest, CompletedRequest } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export { Mockttp };

export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpServer(options);
}

export function getRemote(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getStandalone(options: StandaloneServerOptions = {}): MockttpStandalone {
    return new MockttpStandalone(options);
}
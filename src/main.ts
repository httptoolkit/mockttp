import MockttpServer from "./server/mockttp-server";
import MockttpClient from "./client/mockttp-client";
import { MockttpStandalone, StandaloneServerOptions } from "./standalone/mockttp-standalone";

import { Mockttp } from "./mockttp";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): Mockttp {
    return new MockttpServer();
}

export function getRemote(): Mockttp {
    return new MockttpClient();
}

export function getStandalone(options: StandaloneServerOptions = {}): MockttpStandalone {
    return new MockttpStandalone(options);
}
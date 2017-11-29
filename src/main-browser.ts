import MockttpClient from "./client/mockttp-client";

import { Mockttp } from "./mockttp";
import { MockServerOptions } from "./server/mockttp-server";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(options: MockServerOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getRemote(): Mockttp {
    return new MockttpClient();
}

export function getStandalone(options: any = {}): never {
    throw new Error('Cannot set up a standalone server within a browser');
}
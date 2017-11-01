import MockttpClient from "./client/mockttp-client";

import { Mockttp } from "./mockttp";
export { Request } from "./types";

export interface MockedEndpoint {
    getSeenRequests(): Request[]
}

export function getLocal(): Mockttp {
    return new MockttpClient();
}

export function getRemote(): Mockttp {
    return new MockttpClient();
}

export function getStandalone(options: any = {}): never {
    throw new Error('Cannot set up a standalone server within a browser');
}
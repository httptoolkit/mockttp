import MockttpClient from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";

export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getRemote(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getStandalone(options: any = {}): never {
    throw new Error('Cannot set up a standalone server within a browser');
}
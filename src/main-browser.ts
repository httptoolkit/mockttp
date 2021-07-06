import { MockttpClient, resetStandalone } from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";
export { Method } from "./types";

// Export rule data builders:
import * as matchers from './rules/matchers';
import * as requestHandlers from './rules/requests/request-handlers';
import * as webSocketHandlers from './rules/websockets/websocket-handlers';
import * as completionCheckers from './rules/completion-checkers';

export { matchers, requestHandlers, webSocketHandlers, completionCheckers };
export { requestHandlers as handlers }; // Backward compat

// Export the core API:
export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getRemote(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getStandalone(options: any = {}): never {
    throw new Error('Cannot set up a standalone server within a browser');
}
export { resetStandalone };
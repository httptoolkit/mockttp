import {
    MockttpClient,
    resetAdminServer
} from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";
export { Method } from "./types";

// Export rule data builders:
import * as matchers from './rules/matchers';
import * as requestHandlers from './rules/requests/request-handlers';
import * as webSocketHandlers from './rules/websockets/websocket-handlers';
import * as completionCheckers from './rules/completion-checkers';

export { matchers, requestHandlers, webSocketHandlers, completionCheckers };
export { requestHandlers as handlers }; // Backward compat

export { MOCKTTP_PARAM_REF } from './rules/rule-parameters';

// Export the core API:
export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getRemote(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getAdminServer(options: any = {}): never {
    throw new Error('Cannot set up an admin server within a browser');
}

export {
    resetAdminServer,
    getAdminServer as getStandalone,
    resetAdminServer as resetStandalone
};
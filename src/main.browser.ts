import { MockttpClient } from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";
export { Method, RulePriority } from "./types";

// Export rule data builders:
import * as matchers from './rules/matchers';
import * as requestHandlerDefinitions from './rules/requests/request-handler-definitions';
import * as webSocketHandlerDefinitions from './rules/websockets/websocket-handler-definitions';
import * as completionCheckers from './rules/completion-checkers';

export {
    matchers,
    requestHandlerDefinitions as requestHandlers,
    webSocketHandlerDefinitions as webSocketHandlers,
    completionCheckers
};

export { MOCKTTP_PARAM_REF } from './rules/rule-parameters';

// Export the core API:
export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getRemote(options: MockttpOptions = {}): Mockttp {
    return new MockttpClient(options);
}

export function getAdminServer(): never {
    throw new Error('Cannot set up an admin server within a browser');
}

export { resetAdminServer } from "./client/admin-client";

export * as PluggableAdmin from './pluggable-admin-api/pluggable-admin';
export * as MockttpPluggableAdmin from './pluggable-admin-api/mockttp-pluggable-admin';
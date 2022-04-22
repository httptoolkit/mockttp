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
    requestHandlerDefinitions,
    webSocketHandlerDefinitions,
    completionCheckers
};

// We re-export definitions to pretend they're real handlers in the browser. This should be safe
// because the missing methods (i.e. handle()) were always unusable in non-Node environments anyway.
// In practice though, new browser code using this should actively use requestHandlerDefinitions instead.
// In future, we should probably expose definitions only for both browsers & node, but that's a
// breaking change.
export const requestHandlers = {
    'SimpleHandler': requestHandlerDefinitions.SimpleHandlerDefinition,
    'CallbackHandler': requestHandlerDefinitions.CallbackHandlerDefinition,
    'StreamHandler': requestHandlerDefinitions.StreamHandlerDefinition,
    'FileHandler': requestHandlerDefinitions.FileHandlerDefinition,
    'PassThroughHandler': requestHandlerDefinitions.PassThroughHandlerDefinition,
    'CloseConnectionHandler': requestHandlerDefinitions.CloseConnectionHandlerDefinition,
    'TimeoutHandler': requestHandlerDefinitions.TimeoutHandlerDefinition,
    'HandlerLookup': requestHandlerDefinitions.HandlerDefinitionLookup
};

export const webSocketHandlers = {
    'PassThroughWebSocketHandler': webSocketHandlerDefinitions.PassThroughWebSocketHandlerDefinition,
    'CloseConnectionHandler': webSocketHandlerDefinitions.CloseConnectionHandlerDefinition,
    'TimeoutHandler': webSocketHandlerDefinitions.TimeoutHandlerDefinition,
    'WsHandlerLookup': webSocketHandlerDefinitions.WsHandlerDefinitionLookup
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
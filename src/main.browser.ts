import { MockttpClient } from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";
export { Method, RulePriority } from "./types";

// Export rule data builders:
import * as matchers from './rules/matchers';
import * as requestStepDefinitions from './rules/requests/request-step-definitions';
import * as webSocketStepDefinitions from './rules/websockets/websocket-step-definitions';
import * as completionCheckers from './rules/completion-checkers';

export {
    matchers,
    requestStepDefinitions as requestSteps,
    webSocketStepDefinitions as webSocketSteps,
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
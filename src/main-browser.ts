import MockttpClient from "./client/mockttp-client";

import { Mockttp, MockttpOptions } from "./mockttp";
export { Method } from "./types";

// Export rule data builders:
import * as matchers from './rules/matchers';
import * as handlers from './rules/handlers';
import * as completionCheckers from './rules/completion-checkers';
export { matchers, handlers, completionCheckers };

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
/**
 * @module Mockttp
 */

import MockttpServer from "./server/mockttp-server";
import MockttpClient, { MockttpClientOptions } from "./client/mockttp-client";
import { MockttpStandalone, StandaloneServerOptions } from "./standalone/mockttp-standalone";

import { Mockttp, MockttpOptions } from "./mockttp";

// Export the core type definitions:
export { Method, InitiatedRequest, CompletedRequest, CompletedResponse, MockedEndpoint } from "./types";
export { Mockttp };

// Export rule data builders & type definitions:
import * as matchers from './rules/matchers';
import * as handlers from './rules/handlers';
import * as completionCheckers from './rules/completion-checkers';

export {
    MockRuleData
} from './rules/mock-rule';
export { matchers, handlers, completionCheckers };

// Export TLS utilities:
export { generateCACertificate, generateSPKIFingerprint } from './util/tls';

// Export the core API:

/**
 * Get a Mockttp instance on the local machine.
 *
 * In most simple environments, you can call this method directly and immediately
 * get a Mockttp instance and start mocking servers.
 *
 * In node, the mocked servers will run in process and require no further setup.
 *
 * In browsers this is an alias for getRemote. You'll need to start a standalone server
 * outside your tests before calling this, which will create and manage your fake servers
 * outside the browser.
 */
export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpServer(options);
}

/**
 * Get a Mockttp instance, controlled through a Mockttp standalone server.
 *
 * This connects to a Mockttp standalone server, and uses that to start
 * and stop mock servers.
 */
export function getRemote(options: MockttpClientOptions = {}): Mockttp {
    return new MockttpClient(options);
}

/**
 * Get a standalone server, which can be used remotely to create & manage mock servers.
 *
 * This function exists so you can set up these servers programmatically, but for most
 * usage you can just run your tests via the `mockttp` binary, which will automatically
 * start and stop a standalone server for you:
 *
 * ```
 * mockttp -c <your test command>
 * ```
 */
export function getStandalone(options: StandaloneServerOptions = {}): MockttpStandalone {
    return new MockttpStandalone(options);
}

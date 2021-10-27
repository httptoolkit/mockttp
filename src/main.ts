import { MockttpServer } from "./server/mockttp-server";
import { MockttpClient, MockttpClientOptions, resetStandalone } from "./client/mockttp-client";
import { MockttpStandalone, StandaloneServerOptions } from "./standalone/mockttp-standalone";

import { Mockttp, MockttpOptions, PortRange } from "./mockttp";

// Export the core type definitions:
export * from "./types";
export type {
    Mockttp,
    MockttpOptions,
    MockttpClientOptions,
    StandaloneServerOptions,
    MockttpStandalone,
    PortRange
};

// Export rule data builders & type definitions:
import * as matchers from './rules/matchers';
import * as requestHandlers from './rules/requests/request-handlers';
import * as webSocketHandlers from './rules/websockets/websocket-handlers';
import * as completionCheckers from './rules/completion-checkers';
export { matchers, requestHandlers, webSocketHandlers, completionCheckers };

import { RequestRuleData } from './rules/requests/request-rule';
import { WebSocketRuleData } from './rules/websockets/websocket-rule';
export type { RequestRuleData, WebSocketRuleData };
export type {
    ProxyConfig,
    ProxySetting,
    ProxySettingSource,
    ProxySettingCallback,
    ProxySettingCallbackParams
} from './rules/proxy-config';

export type { RequestRuleBuilder } from "./rules/requests/request-rule-builder";
export type { WebSocketRuleBuilder } from "./rules/websockets/websocket-rule-builder";

export { MOCKTTP_PARAM_REF, RuleParameterReference } from './rules/rule-parameters';

// Old pre-WebSocket names, exported for backward compat:
export { requestHandlers as handlers, RequestRuleData as MockRuleData };

// Export TLS utility methods:
export {
    generateCACertificate,
    generateSPKIFingerprint
} from './util/tls';

// Export various referenced utility types:
export type {
    CAOptions,
    PEM,
    HttpsOptions,
    HttpsPathOptions
} from './util/tls';
export type { CachedDns, DnsLookupFunction } from './util/dns';
export type { MaybePromise } from './util/type-utils';

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

export { resetStandalone };
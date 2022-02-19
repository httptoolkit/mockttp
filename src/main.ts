import { Mockttp, MockttpOptions, SubscribableEvent, PortRange } from "./mockttp";
import { MockttpServer } from "./server/mockttp-server";
import {
    MockttpClient,
    MockttpClientOptions
} from "./client/mockttp-client";
import { MockttpAdminServer, MockttpAdminServerOptions } from "./admin/mockttp-admin-server";

// Export the core type definitions:
export * from "./types";
export type {
    Mockttp,
    MockttpServer,
    MockttpAdminServer,
    MockttpOptions,
    MockttpClientOptions,
    MockttpAdminServerOptions,
    SubscribableEvent,
    PortRange
};

// Export rule data builders & type definitions:
import * as matchers from './rules/matchers';
import * as requestHandlers from './rules/requests/request-handlers';
import * as requestHandlerDefinitions from './rules/requests/request-handler-definitions';
import * as webSocketHandlers from './rules/websockets/websocket-handlers';
import * as webSocketHandlerDefinitions from './rules/websockets/websocket-handler-definitions';
import * as completionCheckers from './rules/completion-checkers';

export {
    matchers,
    requestHandlers,
    requestHandlerDefinitions,
    webSocketHandlers,
    webSocketHandlerDefinitions,
    completionCheckers
};

import type { RequestRule, RequestRuleData } from './rules/requests/request-rule';
import type { WebSocketRule, WebSocketRuleData } from './rules/websockets/websocket-rule';

export type { RequestRule, RequestRuleData, WebSocketRule, WebSocketRuleData };
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
export type { ServerMockedEndpoint } from "./server/mocked-endpoint";

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
export type { Serialized, SerializedValue } from './util/serialization';
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
 * In browsers this is an alias for getRemote. You'll need to start a Mockttp admin server
 * outside your tests before calling this, which will create and manage your fake servers
 * outside the browser.
 */
export function getLocal(options: MockttpOptions = {}): Mockttp {
    return new MockttpServer(options);
}

/**
 * Get a Mockttp instance, controlled through a Mockttp admin server.
 *
 * This connects to a Mockttp admin server, and uses that to start
 * and stop mock servers.
 */
export function getRemote(options: MockttpClientOptions = {}): Mockttp {
    return new MockttpClient(options);
}

/**
 * Get a Mockttp admin server, which can be used with a Mockttp remote client to create
 * & manage Mockttp instances either from remote machines or from local environments
 * that lack necessary capabilities, e.g. to use Mockttp from inside a browser.
 *
 * This function exists so you can set up these servers programmatically, but for most
 * usage you can just run your tests via the `mockttp` binary, which will automatically
 * start and stop an admin server for you:
 *
 * ```
 * mockttp -c <your test command>
 * ```
 */
export function getAdminServer(options: MockttpAdminServerOptions = {}): MockttpAdminServer {
    return new MockttpAdminServer(options);
}
import { resetAdminServer } from "./client/admin-client";
export { resetAdminServer };

/**
 * This API is not yet stable, and is intended for internal use only. It may change in future
 * in minor versions without warning.
 *
 * The pluggable admin components allow composing an admin server and client that are capable
 * of managing arbitrary mock protocols, including Mockttp but also others, depending on the
 * admin plugins used.
 * @category Internal
 */
export * as PluggableAdmin from './pluggable-admin';

// ------------------------------------------------------------------------------
// Various old names, still exported (but marked deprecated) for backward compat:
// ------------------------------------------------------------------------------

/**
 * @deprecated alias for requestHandlers
 */
export const handlers = requestHandlers
/**
 * @deprecated alias for RequestRuleData
 */
export type MockRuleData = RequestRuleData;

/**
 * @deprecated alias for getAdminServer.
 */
export const getStandalone = getAdminServer;
/**
 * @deprecated alias for resetAdminServer
 */
export const resetStandalone = resetAdminServer;
/**
 * @deprecated alias for MockttpAdminServerOptions
 */
export type StandaloneServerOptions = MockttpAdminServerOptions;
/**
 * @deprecated alias for MockttpAdminServer
 */
export type MockttpStandalone = MockttpAdminServer;
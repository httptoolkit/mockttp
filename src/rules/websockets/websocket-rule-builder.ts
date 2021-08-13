import { MockedEndpoint } from "../../types";
import { WebSocketRuleData } from "./websocket-rule";

import {
    PassThroughWebSocketHandler,
    TimeoutHandler,
    CloseConnectionHandler,
    PassThroughWebSocketHandlerOptions
} from './websocket-handlers';

import { BaseRuleBuilder } from "../base-rule-builder";

/**
 * @class WebSocketRuleBuilder

 * A builder for defining websocket mock rules. Create one using
 * `.websocket(path)` on a Mockttp instance, then call whatever
 * methods you'd like here to define more precise matching behaviour,
 * control how the connection is handled, and how many times this
 * rule should be applied.
 *
 * When you're done, call a `.thenX()` method to register the configured rule
 * with the server. These return a promise for a MockedEndpoint, which can be
 * used to verify the details of the requests matched by the rule.
 *
 * This returns a promise because rule registration can be asynchronous,
 * either when using a remote server or testing in the browser. Wait for the
 * promise returned by `.thenX()` methods to guarantee that the rule has taken
 * effect before sending requests to it.
 */
export class WebSocketRuleBuilder extends BaseRuleBuilder {

    /**
     * Mock rule builders should be constructed through the Mockttp instance you're
     * using, not directly. You shouldn't ever need to call this constructor.
     */
    constructor(
        private addRule: (rule: WebSocketRuleData) => Promise<MockedEndpoint>
    ) {
        super();
    }

    /**
     * Pass matched websockets through to their real destination. This works
     * for proxied requests only, and direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. See {@link PassThroughWebSocketHandlerOptions} for the full
     * details of the options available.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenPassThrough(options: PassThroughWebSocketHandlerOptions = {}): Promise<MockedEndpoint> {
        const rule: WebSocketRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughWebSocketHandler(options)
        };

        return this.addRule(rule);
    }

    /**
     * Forward matched websockets on to the specified forwardToUrl. The url
     * specified must not include a path or an error will be thrown.
     * The path portion of the original request url is used instead.
     *
     * The url may optionally contain a protocol. If it does, it will override
     * the protocol (and potentially the port, if unspecified) of the request.
     * If no protocol is specified, the protocol (and potentially the port)
     * of the original request URL will be used instead.
     *
     * This method takes options to configure how the request is passed
     * through. See {@link PassThroughWebSocketHandlerOptions} for the full
     * details of the options available.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    async thenForwardTo(
        forwardToLocation: string,
        options: Omit<PassThroughWebSocketHandlerOptions, 'forwarding'> & {
            forwarding?: Omit<PassThroughWebSocketHandlerOptions['forwarding'], 'targetHost'>
        } = {}
    ): Promise<MockedEndpoint> {
        const rule: WebSocketRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughWebSocketHandler({
                ...options,
                forwarding: {
                    ...options.forwarding,
                    targetHost: forwardToLocation
                }
            })
        };

        return this.addRule(rule);
    }

    /**
     * Close connections that match this rule immediately, without accepting
     * the socket or sending any other response.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenCloseConnection(): Promise<MockedEndpoint> {
        const rule: WebSocketRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new CloseConnectionHandler()
        };

        return this.addRule(rule);
    }

    /**
     * Hold open connections that match this rule, but never respond
     * with anything at all, typically causing a timeout on the client side.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenTimeout(): Promise<MockedEndpoint> {
        const rule: WebSocketRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new TimeoutHandler()
        };

        return this.addRule(rule);
    }
}

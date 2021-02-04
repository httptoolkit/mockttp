/**
 * @module MockWebsocketRule
 */

import { MockedEndpoint } from "../../types";
import { MockWsRuleData } from "./mock-ws-rule";

import {
    PassThroughWebSocketHandler,
    TimeoutHandler,
    CloseConnectionHandler
} from './ws-handlers';

import { BaseRuleBuilder } from "../base-rule-builder";

/**
 * @class MockWsRuleBuilder

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
export class MockWsRuleBuilder extends BaseRuleBuilder {

    /**
     * Mock rule builders should be constructed through the Mockttp instance you're
     * using, not directly. You shouldn't ever need to call this constructor.
     */
    constructor(
        private addRule: (rule: MockWsRuleData) => Promise<MockedEndpoint>
    ) {
        super();
    }

    /**
     * Pass matched websockets through to their real destination. This works
     * for proxied requests only, and direct requests will be rejected with
     * an error.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenPassThrough(): Promise<MockedEndpoint> {
        const rule: MockWsRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughWebSocketHandler()
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
        const rule: MockWsRuleData = {
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
        const rule: MockWsRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new TimeoutHandler()
        };

        return this.addRule(rule);
    }
}

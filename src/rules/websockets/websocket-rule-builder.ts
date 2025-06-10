import { MockedEndpoint, Headers } from "../../types";
import type { WebSocketRuleData } from "./websocket-rule";

import {
    PassThroughWebSocketStep,
    TimeoutStep,
    CloseConnectionStep,
    ResetConnectionStep,
    PassThroughWebSocketStepOptions,
    RejectWebSocketStep,
    EchoWebSocketStep,
    ListenWebSocketStep,
    DelayStep,
    WebSocketStepDefinition
} from './websocket-step-definitions';

import { BaseRuleBuilder } from "../base-rule-builder";
import { WildcardMatcher } from "../matchers";

/**
 * @class WebSocketRuleBuilder

 * A builder for defining websocket mock rules. Create one using
 * `.forAnyWebSocket(path)` on a Mockttp instance, then call whatever
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

        // By default, websockets just match everything:
        this.matchers.push(new WildcardMatcher());
    }

    private steps: Array<WebSocketStepDefinition> = [];

    /**
     * Add a delay (in milliseconds) before the next step in the rule
     */
    delay(ms: number): this {
        this.steps.push(new DelayStep(ms));
        return this;
    }

    /**
     * Pass matched websockets through to their real destination. This works
     * for proxied requests only, and direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. See {@link PassThroughWebSocketStepOptions} for the full
     * details of the options available.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    thenPassThrough(options: PassThroughWebSocketStepOptions = {}): Promise<MockedEndpoint> {
        this.steps.push(new PassThroughWebSocketStep(options));

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
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
     * through. See {@link PassThroughWebSocketStepOptions} for the full
     * details of the options available.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    async thenForwardTo(
        forwardToLocation: string,
        options: Omit<PassThroughWebSocketStepOptions, 'forwarding'> & {
            forwarding?: Omit<PassThroughWebSocketStepOptions['forwarding'], 'targetHost'>
        } = {}
    ): Promise<MockedEndpoint> {
        this.steps.push(new PassThroughWebSocketStep({
            ...options,
            forwarding: {
                ...options.forwarding,
                targetHost: forwardToLocation
            }
        }));

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
        };

        return this.addRule(rule);
    }

    /**
     * Accept incoming WebSocket connections, and echo every message
     * received on the WebSocket back to the client.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    thenEcho(): Promise<MockedEndpoint> {
        this.steps.push(new EchoWebSocketStep());

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
        };

        return this.addRule(rule);
    }

    /**
     * Accept incoming WebSocket connections, and simply listen to
     * incoming messages without ever sending anything in return.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    thenPassivelyListen(): Promise<MockedEndpoint> {
        this.steps.push(new ListenWebSocketStep());

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
        };

        return this.addRule(rule);
    }

    /**
     * Rejects connections, sending an HTTP response with the given
     * status, message and body, to explicitly refuse the WebSocket
     * handshake.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    thenRejectConnection(
        statusCode: number,
        statusMessage?: string,
        headers?: Headers,
        body?: Buffer | string
    ): Promise<MockedEndpoint> {
        this.steps.push(new RejectWebSocketStep(
            statusCode,
            statusMessage,
            headers,
            body
        ));

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
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
     *
     * @category Responses
     */
    thenCloseConnection(): Promise<MockedEndpoint> {
        this.steps.push(new CloseConnectionStep());

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
        };

        return this.addRule(rule);
    }

    /**
     * Reset connections that match this rule immediately, sending a TCP
     * RST packet directly, without accepting the socket or sending any
     * other response, and without cleanly closing the TCP connection.
     *
     * This is only supported in Node.js versions (>=16.17, >=18.3.0, or
     * later), where `net.Socket` includes the `resetAndDestroy` method.
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     *
     * @category Responses
     */
    thenResetConnection(): Promise<MockedEndpoint> {
        this.steps.push(new ResetConnectionStep());

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
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
     *
     * @category Responses
     */
    thenTimeout(): Promise<MockedEndpoint> {
        this.steps.push(new TimeoutStep());

        const rule: WebSocketRuleData = {
            ...this.buildBaseRuleData(),
            steps: this.steps
        };

        return this.addRule(rule);
    }
}

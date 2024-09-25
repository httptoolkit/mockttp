import { merge, isString, isBuffer } from "lodash";
import { Readable } from "stream";

import { Headers, CompletedRequest, Method, MockedEndpoint, Trailers } from "../../types";
import type { RequestRuleData } from "./request-rule";

import {
    SimpleHandlerDefinition,
    PassThroughHandlerDefinition,
    CallbackHandlerDefinition,
    CallbackResponseResult,
    StreamHandlerDefinition,
    CloseConnectionHandlerDefinition,
    TimeoutHandlerDefinition,
    PassThroughHandlerOptions,
    FileHandlerDefinition,
    JsonRpcResponseHandlerDefinition,
    ResetConnectionHandlerDefinition,
    CallbackResponseMessageResult
} from "./request-handler-definitions";
import { MaybePromise } from "../../util/type-utils";
import { byteLength } from "../../util/util";
import { BaseRuleBuilder } from "../base-rule-builder";
import { MethodMatcher, RegexPathMatcher, SimplePathMatcher, WildcardMatcher } from "../matchers";

/**
 * @class RequestRuleBuilder

 * A builder for defining mock rules. Create one using a method like
 * `.forGet(path)` or `.forPost(path)` on a Mockttp instance, then call
 * whatever methods you'd like here to define more precise request
 * matching behaviour, control how the request is handled, and how
 * many times this rule should be applied.
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
export class RequestRuleBuilder extends BaseRuleBuilder {

    private addRule: (rule: RequestRuleData) => Promise<MockedEndpoint>;

    /**
     * Mock rule builders should be constructed through the Mockttp instance you're
     * using, not directly. You shouldn't ever need to call this constructor.
     */
    constructor(addRule: (rule: RequestRuleData) => Promise<MockedEndpoint>)
    constructor(
        method: Method,
        path: string | RegExp | undefined,
        addRule: (rule: RequestRuleData) => Promise<MockedEndpoint>
    )
    constructor(
        methodOrAddRule: Method | ((rule: RequestRuleData) => Promise<MockedEndpoint>),
        path?: string | RegExp,
        addRule?: (rule: RequestRuleData) => Promise<MockedEndpoint>
    ) {
        super();

        // Add the basic method and path matchers inititally, if provided:
        const method = methodOrAddRule instanceof Function ? undefined : methodOrAddRule;
        if (method === undefined && path === undefined) {
            this.matchers.push(new WildcardMatcher());
        } else {
            if (method !== undefined) {
                this.matchers.push(new MethodMatcher(method));
            }

            if (path instanceof RegExp) {
                this.matchers.push(new RegexPathMatcher(path));
            } else if (typeof path === 'string') {
                this.matchers.push(new SimplePathMatcher(path));
            }
        }

        // Store the addRule callback:
        if (methodOrAddRule instanceof Function) {
            this.addRule = methodOrAddRule;
        } else {
            this.addRule = addRule!;
        }
    }

    /**
     * Reply to matched requests with a given status code and (optionally) status message,
     * body, headers & trailers.
     *
     * If one string argument is provided, it's used as the body. If two are
     * provided (even if one is empty) then the 1st is the status message, and
     * the 2nd the body. If no headers are provided, only the standard required
     * headers are set, e.g. Date and Transfer-Encoding.
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
    thenReply(
        status: number,
        data?: string | Buffer,
        headers?: Headers,
        trailers?: Trailers
    ): Promise<MockedEndpoint>;
    thenReply(
        status: number,
        statusMessage: string,
        data: string | Buffer,
        headers?: Headers,
        trailers?: Trailers
    ): Promise<MockedEndpoint>
    thenReply(
        status: number,
        dataOrMessage?: string | Buffer,
        dataOrHeaders?: string | Buffer | Headers,
        headersOrTrailers?: Headers | Trailers,
        trailers?: Trailers
    ): Promise<MockedEndpoint> {
        let data: string | Buffer | undefined;
        let statusMessage: string | undefined;
        let headers: Headers | undefined;

        if (isBuffer(dataOrHeaders) || isString(dataOrHeaders)) {
            data = dataOrHeaders as (Buffer | string);
            statusMessage = dataOrMessage as string;
            headers = headersOrTrailers as Headers;
        } else {
            data = dataOrMessage as string | Buffer | undefined;
            headers = dataOrHeaders as Headers | undefined;
            trailers = headersOrTrailers as Trailers | undefined;
        }

        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new SimpleHandlerDefinition(
                status,
                statusMessage,
                data,
                headers,
                trailers
            )
        };

        return this.addRule(rule);
    }

    /**
     * Reply to matched requests with the given status & JSON and (optionally)
     * extra headers.
     *
     * This method is (approximately) shorthand for:
     * server.forGet(...).thenReply(status, JSON.stringify(data), { 'Content-Type': 'application/json' })
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
    thenJson(status: number, data: object, headers: Headers = {}): Promise<MockedEndpoint> {
        const jsonData = JSON.stringify(data);

        headers = merge({
            'Content-Type': 'application/json',

            'Content-Length': byteLength(jsonData).toString(),
            'Connection': 'keep-alive'
            // ^ Neither strictly required, but without both Node will close the server
            // connection after the response is sent, which can confuse clients.
        }, headers);

        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new SimpleHandlerDefinition(status, undefined, jsonData, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Call the given callback for any matched requests that are received,
     * and build a response from the result.
     *
     * The callback should return a response object with the fields as
     * defined by {@link CallbackResponseMessageResult} to define the response,
     * or the string 'close' to immediately close the connection. The callback
     * can be asynchronous, in which case it should return this value wrapped
     * in a promise.
     *
     * If the callback throws an exception, the server will return a 500
     * with the exception message.
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
    thenCallback(callback:
        (request: CompletedRequest) => MaybePromise<CallbackResponseResult>
    ): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new CallbackHandlerDefinition(callback)
        }

        return this.addRule(rule);
    }

    /**
     * Respond immediately with the given status (and optionally, headers),
     * and then stream the given stream directly as the response body.
     *
     * Note that streams can typically only be read once, and as such
     * this rule will only successfully trigger once. Subsequent requests
     * will receive a 500 and an explanatory error message. To mock
     * repeated requests with streams, create multiple streams and mock
     * them independently.
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
    thenStream(status: number, stream: Readable, headers?: Headers): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new StreamHandlerDefinition(status, stream, headers)
        }

        return this.addRule(rule);
    }

    /**
     * Reply to matched requests with a given status code and the current contents
     * of a given file. The status message and headers can also be optionally
     * provided here. If no headers are provided, only the standard required
     * headers are set.
     *
     * The file is read near-fresh for each request, and external changes to its
     * content will be immediately appear in all subsequent requests.
     *
     * If one string argument is provided, it's used as the body file path.
     * If two are provided (even if one is empty), then 1st is the status message,
     * and the 2nd the body. This matches the argument order of thenReply().
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
    thenFromFile(status: number, filePath: string, headers?: Headers): Promise<MockedEndpoint>;
    thenFromFile(status: number, statusMessage: string, filePath: string, headers?: Headers): Promise<MockedEndpoint>
    thenFromFile(
        status: number,
        pathOrMessage: string,
        pathOrHeaders?: string | Headers,
        headers?: Headers
    ): Promise<MockedEndpoint> {
        let path: string;
        let statusMessage: string | undefined;
        if (isString(pathOrHeaders)) {
            path = pathOrHeaders;
            statusMessage = pathOrMessage as string;
        } else {
            path = pathOrMessage;
            headers = pathOrHeaders as Headers | undefined;
        }

        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new FileHandlerDefinition(status, statusMessage, path, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Pass matched requests through to their real destination. This works
     * for proxied requests only, direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. See {@link PassThroughHandlerOptions} for the full details
     * of the options available.
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
    thenPassThrough(options?: PassThroughHandlerOptions): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new PassThroughHandlerDefinition(options)
        };

        return this.addRule(rule);
    }

    /**
     * Forward matched requests on to the specified forwardToUrl. The url
     * specified must not include a path. Otherwise, an error is thrown.
     * The path portion of the original request url is used instead.
     *
     * The url may optionally contain a protocol. If it does, it will override
     * the protocol (and potentially the port, if unspecified) of the request.
     * If no protocol is specified, the protocol (and potentially the port)
     * of the original request URL will be used instead.
     *
     * This method takes options to configure how the request is passed
     * through. See {@link PassThroughHandlerOptions} for the full details
     * of the options available.
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
        options: Omit<PassThroughHandlerOptions, 'forwarding'> & {
            forwarding?: Omit<PassThroughHandlerOptions['forwarding'], 'targetHost'>
        } = {}
    ): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new PassThroughHandlerDefinition({
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
     * Close connections that match this rule immediately, without
     * any status code or response.
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
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new CloseConnectionHandlerDefinition()
        };

        return this.addRule(rule);
    }

    /**
     * Reset connections that match this rule immediately, sending a TCP
     * RST packet directly, without any status code or response, and without
     * cleanly closing the TCP connection.
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
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new ResetConnectionHandlerDefinition()
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
        const rule: RequestRuleData = {
            ...this.buildBaseRuleData(),
            handler: new TimeoutHandlerDefinition()
        };

        return this.addRule(rule);
    }

    /**
     * Send a successful JSON-RPC response to a JSON-RPC request. The response data
     * can be any JSON-serializable value. If a matching request is received that
     * is not a valid JSON-RPC request, it will be rejected with an HTTP error.
     *
     * @category Responses
     */
    thenSendJsonRpcResult(result: any) {
        const rule = {
            ...this.buildBaseRuleData(),
            handler: new JsonRpcResponseHandlerDefinition({ result })
        };

        return this.addRule(rule);
    }

    /**
     * Send a failing error JSON-RPC response to a JSON-RPC request. The error data
     * can be any JSON-serializable value. If a matching request is received that
     * is not a valid JSON-RPC request, it will be rejected with an HTTP error.
     *
     * @category Responses
     */
    thenSendJsonRpcError(error: any) {
        const rule = {
            ...this.buildBaseRuleData(),
            handler: new JsonRpcResponseHandlerDefinition({ error })
        };

        return this.addRule(rule);
    }
}

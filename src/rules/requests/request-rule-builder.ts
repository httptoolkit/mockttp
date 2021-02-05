/**
 * @module MockRule
 */

import { merge, isString, isBuffer } from "lodash";
import { Readable } from "stream";

import { Headers, CompletedRequest, Method, MockedEndpoint } from "../../types";
import { RequestRuleData } from "./request-rule";

import {
    SimpleHandler,
    PassThroughHandler,
    CallbackHandler,
    CallbackResponseResult,
    StreamHandler,
    CloseConnectionHandler,
    TimeoutHandler,
    PassThroughHandlerOptions,
    FileHandler,
} from "./request-handlers";
import { MaybePromise } from "../../util/type-utils";
import { byteLength } from "../../util/util";
import { BaseRuleBuilder } from "../base-rule-builder";

/**
 * @class RequestRuleBuilder

 * A builder for defining mock rules. Create one using a method like
 * `.get(path)` or `.post(path)` on a Mockttp instance, then call
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
        super(
            methodOrAddRule instanceof Function ? undefined : methodOrAddRule,
            path
        );

        if (methodOrAddRule instanceof Function) {
            this.addRule = methodOrAddRule;
        } else {
            this.addRule = addRule!;
        }
    }

    /**
     * Reply to matched requests with a given status code and (optionally) status message,
     * body and headers.
     *
     * If one string argument is provided, it's used as the body. If two are
     * provided (even if one is empty), then 1st is the status message, and
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
     */
    thenReply(status: number, data?: string | Buffer, headers?: Headers): Promise<MockedEndpoint>;
    thenReply(
        status: number,
        statusMessage: string,
        data: string | Buffer,
        headers?: Headers
    ): Promise<MockedEndpoint>
    thenReply(
        status: number,
        dataOrMessage?: string | Buffer,
        dataOrHeaders?: string | Buffer | Headers,
        headers?: Headers
    ): Promise<MockedEndpoint> {
        let data: string | Buffer | undefined;
        let statusMessage: string | undefined;
        if (isBuffer(dataOrHeaders) || isString(dataOrHeaders)) {
            data = dataOrHeaders as (Buffer | string);
            statusMessage = dataOrMessage as string;
        } else {
            data = dataOrMessage as string | Buffer | undefined;
            headers = dataOrHeaders as Headers | undefined;
        }

        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new SimpleHandler(status, statusMessage, data, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Reply to matched requests with the given status & JSON and (optionally)
     * extra headers.
     *
     * This method is shorthand for:
     * server.get(...).thenReply(status, JSON.stringify(data), { 'Content-Type': 'application/json' })
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenJson(status: number, data: object, headers: Headers = {}): Promise<MockedEndpoint> {
        const jsonData = JSON.stringify(data);

        headers = merge({
            'Content-Type': 'application/json',
            'Content-Length': byteLength(jsonData).toString()
        }, headers);

        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new SimpleHandler(status, undefined, jsonData, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Deprecated alias for thenJson
     * @deprecated
     */
    thenJSON = this.thenJson;

    /**
     * Call the given callback for any matched requests that are received,
     * and build a response from the result.
     *
     * The callback should return a response object or a promise for one.
     * The response object may include various fields to define the response.
     * All fields are optional, with the defaults listed below.
     *
     * Valid fields are:
     * - `status` (number, defaults to 200)
     * - `body` (string or buffer, defaults to empty)
     * - `headers` (object with string keys & values, defaults to standard required headers)
     * - `json` (object, which will be sent as a JSON response, unset by default)
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
     */
    thenCallback(callback:
        (request: CompletedRequest) => MaybePromise<CallbackResponseResult>
    ): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new CallbackHandler(callback)
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
     */
    thenStream(status: number, stream: Readable, headers?: Headers): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new StreamHandler(status, stream, headers)
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
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new FileHandler(status, statusMessage, path, headers)
        };

        return this.addRule(rule);
    }

    /**
     * Pass matched requests through to their real destination. This works
     * for proxied requests only, direct requests will be rejected with
     * an error.
     *
     * This method takes options to configure how the request is passed
     * through. The available options are:
     *
     * * ignoreHostCertificateErrors, a list of hostnames for which server
     *   certificate errors should be ignored (none, by default).
     * * clientCertificateHostMap, a mapping of hosts to client certificates to use,
     *   in the form of { key, cert } objects (none, by default)
     * * beforeRequest, a callback that will be passed the full request
     *   before it is passed through, and which returns an object that defines
     *   how the the request content should be changed before it's passed
     *   to the upstream server (details below).
     * * beforeResponse, a callback that will be passed the full response
     *   before it is completed, and which returns an object that defines
     *   how the the response content should be changed before it's returned
     *   to the client (details below).
     *
     * The beforeRequest & beforeResponse callbacks should return objects
     * defining how the request/response should be changed. All fields on
     * the object are optional. The valid fields are:
     *
     * Valid fields are:
     * - Request only: `method` (a replacement HTTP verb, capitalized)
     * - Request only: `url` (a full URL to send the request to)
     * - Request only: `response` (a response callback result: if provided
     *   this will be used directly, the request will not be passed through
     *   at all, and any beforeResponse callback will never fire)
     * - Response only: `status` (number, will replace the HTTP status code)
     * - Both: `headers` (object with string keys & values, replaces all
     *   headers if set)
     * - Both: `body` (string or buffer, replaces the body if set)
     * - Both: `json` (object, to be sent as a JSON-encoded body, taking
     *   precedence over `body` if both are set)
     *
     * Calling this method registers the rule with the server, so it
     * starts to handle requests.
     *
     * This method returns a promise that resolves with a mocked endpoint.
     * Wait for the promise to confirm that the rule has taken effect
     * before sending requests to be matched. The mocked endpoint
     * can be used to assert on the requests matched by this rule.
     */
    thenPassThrough(options?: PassThroughHandlerOptions): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughHandler(options)
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
     * This method also takes options to configure how the request is passed
     * through, see thenPassThrough for more details.
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
        options: Omit<PassThroughHandlerOptions, 'forwarding'> & {
            forwarding?: Omit<PassThroughHandlerOptions['forwarding'], 'targetHost'>
        } = {}
    ): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new PassThroughHandler({
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
     */
    thenCloseConnection(): Promise<MockedEndpoint> {
        const rule: RequestRuleData = {
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
        const rule: RequestRuleData = {
            matchers: this.matchers,
            completionChecker: this.completionChecker,
            handler: new TimeoutHandler()
        };

        return this.addRule(rule);
    }
}

/**
 * @module Mockttp
 */

import MockRuleBuilder from "./rules/mock-rule-builder";
import { ProxyConfig, MockedEndpoint, Method, OngoingRequest, CompletedRequest } from "./types";
import { MockRuleData } from "./rules/mock-rule-types";
import { CAOptions } from './util/tls';

/**
 * A mockttp instance allow you to start and stop mock servers and control their behaviour.
 * 
 * Call `.start()` to set up a server on a random port, use methods like `.get(url)`,
 * `.post(url)` and `.anyRequest()` to get a {@link MockRuleBuilder} and start defining
 * mock rules. Call `.stop()` when your test is complete.
 */
export interface Mockttp {
    /**
     * Start a mock server.
     * 
     * Specify a fixed port if you need one. If you don't, a random port will be chosen, which
     * you can get later with `.port`, or by using `.url` and `.urlFor(path)` to generate
     * your URLs automatically.
     */
    start(port?: number): Promise<void>;

    /**
     * Stop the mock server and reset the rules.
     */
    stop(): Promise<void>;

    /**
     * Enable extra debug output so you can understand exactly what the server is doing.
     */
    enableDebug(): void;

    /**
     * Reset the stored rules. Most of the time it's better to start & stop the server instead,
     * but this can be useful in some special cases.
     */
    reset(): void;

    /**
     * The root URL of the server.
     * 
     * This will throw an error if read before the server is started.
     */
    url: string;

    /**
     * The URL for a given path on the server.
     * 
     * This will throw an error if read before the server is started.
     */
    urlFor(path: string): string;
    /**
     * The port the server is running on.
     * 
     * This will throw an error if read before the server is started.
     */
    port: number;
    /**
     * The environment variables typically needed to use this server as a proxy, in a format you
     * can add to your environment straight away.
     * 
     * This will throw an error if read before the server is started.
     * 
     * ```
     * process.env = Object.assign(process.env, mockServer.proxyEnv)
     * ```
     */
    proxyEnv: ProxyConfig;

    /**
     * Get a builder for a mock rule that will match any requests on any path.
     */
    anyRequest(): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match GET requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    get(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match POST requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    post(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match PUT requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    put(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match DELETE requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    delete(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match PATCH requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    patch(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match HEAD requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     */
    head(url: string | RegExp): MockRuleBuilder;
    /**
     * Get a builder for a mock rule that will match OPTIONS requests for the given path.
     * 
     * The path can be either a string, or a regular expression to match against.
     * 
     * This can only be used if the `cors` option has been set to false.
     * 
     * If cors is true (the default when using a remote client, e.g. in the browser),
     * then the mock server automatically handles OPTIONS requests to ensure requests
     * to the server are allowed by clients observing CORS rules.
     * 
     * You can pass `{cors: false}` to `getLocal`/`getRemote` to disable this behaviour,
     * but if you're testing in a browser you will need to ensure you mock all OPTIONS
     * requests appropriately so that the browser allows your other requests to be sent.
     */
    options(url: string | RegExp): MockRuleBuilder;

    /**
     * Subscribe to hear about request details as they're received.
     *
     * This is only useful in some niche use cases, such as logging all requests seen
     * by the server independently of the rules defined.
     *
     * The callback will be called asynchronously from request handling. This function
     * returns a promise, and the callback is not guaranteed to be registered until
     * the promise is resolved.
     */
    on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;
}

export interface MockttpOptions {
    cors?: boolean;
    debug?: boolean;
    https?: CAOptions
}

/**
 * @hidden
 */
export abstract class AbstractMockttp {
    protected cors: boolean;
    protected debug: boolean;

    abstract get url(): string;
    abstract addRule: (ruleData: MockRuleData) => Promise<MockedEndpoint>;
    abstract on(event: 'request', callback: (req: CompletedRequest) => void): Promise<void>;

    constructor(options: MockttpOptions) {
        this.debug = options.debug || false;
        this.cors = options.cors || false;
    }

    get proxyEnv(): ProxyConfig {
        return {
            HTTP_PROXY: this.url,
            HTTPS_PROXY: this.url
        }
    }

    urlFor(path: string): string {
        return this.url + path;
    }

    anyRequest(): MockRuleBuilder {
        return new MockRuleBuilder(this.addRule);
    }

    get(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.GET, url, this.addRule);
    }

    post(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.POST, url, this.addRule);
    }

    put(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.PUT, url, this.addRule);
    }
    
    delete(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.DELETE, url, this.addRule);
    }

    patch(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.PATCH, url, this.addRule);
    }

    head(url: string | RegExp): MockRuleBuilder {
        return new MockRuleBuilder(Method.HEAD, url, this.addRule);
    }

    options(url: string | RegExp): MockRuleBuilder {
        if (this.cors) {
            throw new Error(`Cannot mock OPTIONS requests with CORS enabled.

You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues \
connecting to your mock server from browsers, unless you mock all required OPTIONS preflight \
responses by hand.`);
        }
        return new MockRuleBuilder(Method.OPTIONS, url, this.addRule);
    }

}
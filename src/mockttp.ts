/**
 * @module Mockttp
 */

import MockRuleBuilder from "./rules/mock-rule-builder";
import { ProxyConfig, MockedEndpoint, Method, OngoingRequest } from "./types";
import { MockRuleData } from "./rules/mock-rule-types";
import { CAOptions } from './util/tls';

export interface Mockttp {
    start(port?: number): Promise<void>;
    stop(): Promise<void>;

    enableDebug(): void;
    reset(): void;

    url: string;
    port: number;
    proxyEnv: ProxyConfig;

    urlFor(path: string): string;

    anyRequest(): MockRuleBuilder;
    get(url: string): MockRuleBuilder;
    post(url: string): MockRuleBuilder;
    put(url: string): MockRuleBuilder;
    delete(url: string): MockRuleBuilder;
    patch(url: string): MockRuleBuilder;
    options(url: string): MockRuleBuilder;

    on(event: 'request', callback: (req: OngoingRequest) => void): Promise<void>;
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
    abstract on(event: 'request', callback: (req: OngoingRequest) => void): Promise<void>;

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

    get(url: string): MockRuleBuilder {
        return new MockRuleBuilder(Method.GET, url, this.addRule);
    }

    post(url: string): MockRuleBuilder {
        return new MockRuleBuilder(Method.POST, url, this.addRule);
    }

    put(url: string): MockRuleBuilder {
        return new MockRuleBuilder(Method.PUT, url, this.addRule);
    }
    
    delete(url: string): MockRuleBuilder {
        return new MockRuleBuilder(Method.DELETE, url, this.addRule);
    }

    patch(url: string): MockRuleBuilder {
        return new MockRuleBuilder(Method.PATCH, url, this.addRule);
    }

    options(url: string): MockRuleBuilder {
        if (this.cors) {
            throw new Error(`Cannot mock OPTIONS requests with CORS enabled.

You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues \
connecting to your mock server from browsers, unless you mock all required OPTIONS preflight \
responses by hand.`);
        }
        return new MockRuleBuilder(Method.OPTIONS, url, this.addRule);
    }

}
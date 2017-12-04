import PartialMockRule from "./rules/partial-mock-rule";
import { ProxyConfig, MockedEndpoint, Method } from "./types";
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

    get(url: string): PartialMockRule;
    post(url: string): PartialMockRule;
    put(url: string): PartialMockRule;
    delete(url: string): PartialMockRule;
    patch(url: string): PartialMockRule;
    options(url: string): PartialMockRule;
}

export interface MockttpOptions {
    cors?: boolean;
    debug?: boolean;
    https?: CAOptions
}

export abstract class AbstractMockttp {
    protected cors: boolean;
    protected debug: boolean;

    abstract get url(): string;
    abstract addRule: (ruleData: MockRuleData) => Promise<MockedEndpoint>;

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

    get(url: string): PartialMockRule {
        return new PartialMockRule(Method.GET, url, this.addRule);
    }

    post(url: string): PartialMockRule {
        return new PartialMockRule(Method.POST, url, this.addRule);
    }

    put(url: string): PartialMockRule {
        return new PartialMockRule(Method.PUT, url, this.addRule);
    }
    
    delete(url: string): PartialMockRule {
        return new PartialMockRule(Method.DELETE, url, this.addRule);
    }

    patch(url: string): PartialMockRule {
        return new PartialMockRule(Method.PATCH, url, this.addRule);
    }

    options(url: string): PartialMockRule {
        if (this.cors) {
            throw new Error(`Cannot mock OPTIONS requests with CORS enabled.

You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues \
connecting to your mock server from browsers, unless you mock all required OPTIONS preflight \
responses by hand.`);
        }
        return new PartialMockRule(Method.OPTIONS, url, this.addRule);
    }

}
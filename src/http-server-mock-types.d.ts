import PartialMockRule from "./rules/partial-mock-rule";
import { ProxyConfig } from "./types";

export interface HttpServerMock {
    start(port?: number): Promise<void>;
    stop(): Promise<void>;

    enableDebug(): void;
    reset(): void;

    url: string;
    proxyEnv: ProxyConfig;
    urlFor(path: string): string;

    get(url: string): PartialMockRule;
    post(url: string): PartialMockRule;
    put(url: string): PartialMockRule;
}
import * as _ from 'lodash';
import * as http from 'http';
import * as https from 'https';
import ProxyAgent = require('proxy-agent');

import { isNode } from "./util";
import { MaybePromise } from './type-utils';

const KeepAliveAgents = isNode
    ? { // These are only used (and only available) on the node server side
        'http:': new http.Agent({
            keepAlive: true
        }),
        'https:': new https.Agent({
            keepAlive: true
        })
    } : {};

export interface ProxyConfig {
    /**
     * The URL for the proxy to forward traffic through.
     *
     * This can be any URL supported by https://www.npmjs.com/package/proxy-agent.
     * For example: http://..., socks5://..., pac+http://...
     */
    proxyUrl: string;

    /**
     * A list of no-proxy values, matching hosts' traffic should *not* be proxied.
     *
     * This is a common proxy feature, but unfortunately isn't standardized. See
     * https://about.gitlab.com/blog/2021/01/27/we-need-to-talk-no-proxy/ for some
     * background. This implementation is intended to match Curl's behaviour, and
     * any differences are a bug.
     *
     * The currently supported formats are:
     * - example.com (matches domain and all subdomains)
     * - example.com:443 (matches domain and all subdomains, but only on that port)
     * - 10.0.0.1 (matches IP, but only when used directly - does not resolve domains)
     *
     * Some other formats (e.g. leading dots or *.) will work, but the leading
     * characters are ignored. More formats may be added in future, e.g. CIDR ranges.
     * To maximize compatibility with values used elsewhere, unrecognized formats
     * will generally be ignored, but may match in unexpected ways.
     */
    noProxy?: string[];
}

export type ProxyConfigCallbackParams = { hostname: string };
export type ProxyConfigCallback = (params: ProxyConfigCallbackParams) => MaybePromise<ProxyConfig | undefined>;

export async function getAgent({
    protocol, hostname, port, tryHttp2, keepAlive, proxyConfig
}: {
    protocol: 'http:' | 'https:' | 'ws:' | 'wss:' | undefined,
    hostname: string,
    port: number,
    tryHttp2: boolean,
    keepAlive: boolean
    proxyConfig: ProxyConfig | ProxyConfigCallback | undefined,
}): Promise<http.Agent | undefined> { // <-- We force this cast for convenience in various different uses later
    if (proxyConfig) {
        if (_.isFunction(proxyConfig)) {
            proxyConfig = await proxyConfig({ hostname });
        }

        if (proxyConfig?.proxyUrl) {
            // If there's a (non-empty) proxy configured, use it. We require non-empty because empty strings
            // will fall back to detecting from the environment, which is likely to behave unexpectedly.

            if (!matchesNoProxy(hostname, port, proxyConfig.noProxy)) {
                // We notably ignore HTTP/2 upstream in this case: it's complicated to mix that up with proxying
                // so for now we ignore it entirely.
                return new ProxyAgent(proxyConfig.proxyUrl) as http.Agent;
            }
        }
    }

    if (tryHttp2 && (protocol === 'https:' || protocol === 'wss:')) {
        // H2 wrapper takes multiple agents, uses the appropriate one for the detected protocol.
        // We notably never use H2 upstream for plaintext, it's rare and we can't use ALPN to detect it.
        return { https: KeepAliveAgents['https:'], http2: undefined } as any as http.Agent;
    } else if (keepAlive && protocol !== 'wss:' && protocol !== 'ws:') {
        // HTTP/1.1 or HTTP/1 with explicit keep-alive
        return KeepAliveAgents[protocol || 'http:']
    } else {
        // HTTP/1 without KA - just send the request with no agent
        return undefined;
    }
}

export const matchesNoProxy = (hostname: string, portNum: number, noProxyValues: string[] | undefined) => {
    if (!noProxyValues || noProxyValues.length === 0) return false; // Skip everything in the common case.

    const port = portNum.toString();
    const hostParts = hostname.split('.').reverse();

    return noProxyValues.some((noProxy) => {
        const [noProxyHost, noProxyPort] = noProxy.split(':') as [string, string | undefined];

        let noProxyParts = noProxyHost.split('.').reverse();
        const lastPart = noProxyParts[noProxyParts.length - 1];
        if (lastPart === '' || lastPart === '*') {
            noProxyParts = noProxyParts.slice(0, -1);
        }

        if (noProxyPort && port !== noProxyPort) return false;

        for (let i = 0; i < noProxyParts.length; i++) {
            let noProxyPart = noProxyParts[i];
            let hostPart = hostParts[i];

            if (hostPart === undefined) return false; // No-proxy is longer than hostname
            if (noProxyPart !== hostPart) return false; // Mismatch
        }

        // If we run out of no-proxy parts with no mismatch then we've matched
        return true;
    });
}
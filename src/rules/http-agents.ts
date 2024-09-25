import * as _ from 'lodash';
import * as url from 'url';
import * as http from 'http';
import * as https from 'https';

import * as LRU from 'lru-cache';

import getHttpsProxyAgent = require('https-proxy-agent');
import { PacProxyAgent } from 'pac-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
const getSocksProxyAgent = (opts: any) => new SocksProxyAgent(opts);

import { isNode } from "../util/util";
import { getProxySetting, matchesNoProxy, ProxySettingSource } from './proxy-config';
import { getTrustedCAs } from './passthrough-handling';

const KeepAliveAgents = isNode
    ? { // These are only used (and only available) on the node server side
        'http:': new http.Agent({
            keepAlive: true
        }),
        'https:': new https.Agent({
            keepAlive: true
        })
    } : {};

const ProxyAgentFactoryMap = {
    'http:': getHttpsProxyAgent, // HTTPS here really means 'CONNECT-tunnelled' - it can do either
    'https:': getHttpsProxyAgent,

    'pac+http:': (...args: any) => new PacProxyAgent(...args),
    'pac+https:': (...args: any) => new PacProxyAgent(...args),

    'socks:': getSocksProxyAgent,
    'socks4:': getSocksProxyAgent,
    'socks4a:': getSocksProxyAgent,
    'socks5:': getSocksProxyAgent,
    'socks5h:': getSocksProxyAgent
} as const;

const proxyAgentCache = new LRU<string, http.Agent>({
    max: 20,

    ttl: 1000 * 60 * 5, // Drop refs to unused agents after 5 minutes
    ttlResolution: 1000 * 60, // Check for expiry once every minute maximum
    ttlAutopurge: true, // Actively drop expired agents
    updateAgeOnGet: true // Don't drop agents while they're in use
});

const getCacheKey = (options: {}) => JSON.stringify(options);

export async function getAgent({
    protocol, hostname, port, tryHttp2, keepAlive, proxySettingSource
}: {
    protocol: 'http:' | 'https:' | 'ws:' | 'wss:' | undefined,
    hostname: string,
    port: number,
    tryHttp2: boolean,
    keepAlive: boolean
    proxySettingSource: ProxySettingSource
}): Promise<http.Agent | undefined> { // <-- We force this cast for convenience in various different uses later
    const proxySetting = await getProxySetting(proxySettingSource, { hostname });

    if (proxySetting?.proxyUrl) {
        // If there's a (non-empty) proxy configured, use it. We require non-empty because empty strings
        // will fall back to detecting from the environment, which is likely to behave unexpectedly.

        if (!matchesNoProxy(hostname, port, proxySetting.noProxy)) {
            // We notably ignore HTTP/2 upstream in this case: it's complicated to mix that up with proxying
            // so for now we ignore it entirely.

            const cacheKey = getCacheKey({
                url: proxySetting.proxyUrl,
                trustedCAs: proxySetting.trustedCAs,
                additionalTrustedCAs: proxySetting.additionalTrustedCAs
            });

            if (!proxyAgentCache.has(cacheKey)) {
                const { href, protocol, auth, hostname, port } = url.parse(proxySetting.proxyUrl);
                const buildProxyAgent = ProxyAgentFactoryMap[protocol as keyof typeof ProxyAgentFactoryMap];

                // If you specify trusted CAs, we override the CAs used for this connection, i.e. the trusted
                // CA for the certificate of an HTTPS proxy. This is *not* the CAs trusted for upstream servers
                // on the otherside of the proxy - see the corresponding passthrough options for that.
                const trustedCerts = await getTrustedCAs(
                    proxySetting.trustedCAs,
                    proxySetting.additionalTrustedCAs
                );

                proxyAgentCache.set(cacheKey, buildProxyAgent({
                    href,
                    protocol,
                    auth,
                    hostname,
                    port,

                    ...(trustedCerts
                        ? { ca: trustedCerts }
                        : {}
                    )
                }));
            }

            return proxyAgentCache.get(cacheKey);
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
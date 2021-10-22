import * as _ from 'lodash';
import * as http from 'http';
import * as https from 'https';
import ProxyAgent = require('proxy-agent');

import { isNode } from "../util/util";
import { getProxySetting, matchesNoProxy, ProxySettingSource } from './proxy-config';

const KeepAliveAgents = isNode
    ? { // These are only used (and only available) on the node server side
        'http:': new http.Agent({
            keepAlive: true
        }),
        'https:': new https.Agent({
            keepAlive: true
        })
    } : {};

export async function getAgent({
    protocol, hostname, port, tryHttp2, keepAlive, proxySettingSource
}: {
    protocol: 'http:' | 'https:' | 'ws:' | 'wss:' | undefined,
    hostname: string,
    port: number,
    tryHttp2: boolean,
    keepAlive: boolean
    proxySettingSource: ProxySettingSource,
}): Promise<http.Agent | undefined> { // <-- We force this cast for convenience in various different uses later
    const proxySetting = await getProxySetting(proxySettingSource, { hostname });

    if (proxySetting?.proxyUrl) {
        // If there's a (non-empty) proxy configured, use it. We require non-empty because empty strings
        // will fall back to detecting from the environment, which is likely to behave unexpectedly.

        if (!matchesNoProxy(hostname, port, proxySetting.noProxy)) {
            // We notably ignore HTTP/2 upstream in this case: it's complicated to mix that up with proxying
            // so for now we ignore it entirely.
            return new ProxyAgent(proxySetting.proxyUrl) as http.Agent;
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
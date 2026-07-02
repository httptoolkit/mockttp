import * as url from 'url';
import type * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import type * as http2 from 'http2';

import * as h2Client from 'http2-wrapper';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { PacProxyAgent } from 'pac-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { getProxySetting, matchesNoProxy, ProxySettingSource } from './proxy-config';
import { getTrustedCAs } from './passthrough-handling';
import { isHttp2 } from '../util/request-utils';
import { OngoingRequest } from '../types';
import { UpstreamConnectionAgents, UpstreamConnectionAgentMap } from '../util/socket-extensions';
import { AbortError } from '../util/abort-error';

/**
 * A downstream connection: the socket, tunnel stream, or H2 session a request arrives on,
 * and that we link its upstream agents to. For a direct or tunnelled non-H2 request this is
 * the socket (or tunnel stream); for an H2 request it's the H2 session, so that all streams
 * multiplexed on one session share upstream connections but separate sessions (e.g. separate
 * H2 CONNECT tunnels) stay isolated.
 */
export type Connection = net.Socket | http2.Http2Session | http2.ServerHttp2Stream;

/**
 * Resolve the downstream connection for a given request. This is the key we use to link
 * upstream agents to their originating connection.
 *
 * Every active request arrives on a connection, so this throws if none can be found.
 */
export function getConnection(
    clientReq: http.IncomingMessage | http2.Http2ServerRequest | OngoingRequest
): Connection {
    const connection = isHttp2(clientReq)
        ? (clientReq as http2.Http2ServerRequest).stream.session
        : (clientReq as http.IncomingMessage).socket;

    if (!connection) {
        throw new AbortError(
            "Cannot proxy a request with no associated downstream connection",
            'E_NO_DOWNSTREAM_CONNECTION'
        );
    }

    return connection;
}

/**
 * Get (or lazily create) the map of upstream agents belonging to a downstream connection.
 * On first creation we bind cleanup to the connection's 'close' event, so that all upstream
 * connections are destroyed as soon as the downstream connection they belong to goes away.
 */
function getConnectionAgents(connection: Connection): UpstreamConnectionAgentMap {
    let agents = connection[UpstreamConnectionAgents];
    if (!agents) {
        agents = new Map();
        connection[UpstreamConnectionAgents] = agents;
        connection.once('close', () => {
            for (const agent of agents!.values()) {
                try {
                    agent.destroy();
                } catch {
                    // Ignore errors destroying already-broken agents
                }
            }
            agents!.clear();
        });
    }
    return agents;
}

function getOrCreateConnectionAgent<T extends { destroy(): void }>(
    connection: Connection,
    key: string,
    buildAgent: () => T
): T {
    const agents = getConnectionAgents(connection);
    let agent = agents.get(key) as T | undefined;
    if (!agent) {
        agent = buildAgent();
        agents.set(key, agent);
    }
    return agent;
}

const buildHttpsProxyAgent = (href: string, opts?: any) => new HttpsProxyAgent(href, opts);
const buildSocksProxyAgent = (href: string, opts?: any) => new SocksProxyAgent(href, opts);

const ProxyAgentFactoryMap = {
    'http:': buildHttpsProxyAgent, // HTTPS here really means 'CONNECT-tunnelled' - it can do either
    'https:': buildHttpsProxyAgent,

    'pac+http:': (...args: any) => new PacProxyAgent(...args),
    'pac+https:': (...args: any) => new PacProxyAgent(...args),

    'socks:': buildSocksProxyAgent,
    'socks4:': buildSocksProxyAgent,
    'socks4a:': buildSocksProxyAgent,
    'socks5:': buildSocksProxyAgent,
    'socks5h:': buildSocksProxyAgent
} as const;

const getCacheKey = (options: {}) => JSON.stringify(options);

// Thrown if the downstream connection dies while we're preparing the upstream agent (an abort
// during our awaits). We can't pool against a dead connection, and the request is being aborted
// anyway, so we fail fast rather than open a doomed upstream connection.
const abortForDeadConnection = () => new AbortError(
    'Downstream connection closed before the upstream connection could be established',
    'E_DOWNSTREAM_ABORT'
);


/**
 * Get the agent to use for a given upstream request, based on config and the downstream
 * connection it arrives on. We aim to match up & downstream connections roughly 1-1 but at
 * most 1-N (i.e. reusing upstreams within a connection, never sharing them across connections).
 */
export async function getAgent({
    connection, protocol, hostname, port, tryHttp2, proxySettingSource
}: {
    connection: Connection,
    protocol: 'http:' | 'https:' | 'ws:' | 'wss:' | undefined,
    hostname: string,
    port: number,
    tryHttp2: boolean,
    proxySettingSource: ProxySettingSource
}): Promise<http.Agent | false> { // <-- We force cast to Agent for convenience in various different uses later
    const proxySetting = await getProxySetting(proxySettingSource, { hostname });

    // If the connection has died (previously, or during above await) then this is pointless.
    if (connection.destroyed) throw abortForDeadConnection();

    // If there's a (non-empty) proxy configured that applies to this host, use it. We require
    // non-empty because empty strings fall back to detecting from the environment, which is
    // likely to behave unexpectedly. (We notably never use HTTP/2 upstream when proxying: it's
    // complicated to mix up with proxying, so we ignore it entirely here.)
    if (proxySetting?.proxyUrl && !matchesNoProxy(hostname, port, proxySetting.noProxy)) {
        const cacheKey = getCacheKey({
            url: proxySetting.proxyUrl,
            trustedCAs: proxySetting.trustedCAs,
            additionalTrustedCAs: proxySetting.additionalTrustedCAs
        });
        const agentKey = `proxy:${cacheKey}`;

        const existing = connection[UpstreamConnectionAgents]?.get(agentKey);
        if (existing) return existing as http.Agent;

        const { href, protocol: proxyProtocol } = url.parse(proxySetting.proxyUrl);
        const buildProxyAgent = ProxyAgentFactoryMap[proxyProtocol as keyof typeof ProxyAgentFactoryMap];

        // If you specify trusted CAs, we override the CAs used for this connection, i.e. the trusted
        // CA for the certificate of an HTTPS proxy. This is *not* the CAs trusted for upstream servers
        // on the other side of the proxy - see the corresponding passthrough options for that.
        const trustedCerts = await getTrustedCAs(
            proxySetting.trustedCAs,
            proxySetting.additionalTrustedCAs
        );

        // We resolve the certs (the only async step) above, so building & attaching the agent
        // below is synchronous - no interleaving, no race with the connection's lifecycle.
        const buildAgent = (): http.Agent => buildProxyAgent(href!, {
            keepAlive: true,
            ...(trustedCerts ? { ca: trustedCerts } : {})
        });

        if (connection.destroyed) throw abortForDeadConnection();
        return getOrCreateConnectionAgent(connection, agentKey, buildAgent);
    }

    // WebSockets hijack the whole connection on upgrade, so there's nothing to pool.
    if (protocol === 'ws:' || protocol === 'wss:') return false;

    if (tryHttp2 && protocol === 'https:') {
        // H2 wrapper takes multiple agents, uses the appropriate one for the detected protocol.
        // We notably never use H2 upstream for plaintext, it's rare and we can't use ALPN to detect it.
        const httpsAgent = getOrCreateConnectionAgent(connection, 'https:', () =>
            new https.Agent({ keepAlive: true })
        );
        const http2Agent = getOrCreateConnectionAgent(connection, 'http2:', () =>
            new h2Client.Agent()
        );
        return { https: httpsAgent, http2: http2Agent } as any as http.Agent;
    } else {
        // A per-connection keep-alive agent. Whether a given socket is actually reused or
        // closed after the response is driven by header and downstream behaviour, so we can
        // just mirror that directly without handling it manually.
        const agentProtocol = protocol || 'http:';
        return getOrCreateConnectionAgent(connection, agentProtocol, () =>
            agentProtocol === 'https:'
                ? new https.Agent({ keepAlive: true })
                : new http.Agent({ keepAlive: true })
        );
    }
}
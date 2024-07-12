import * as _ from 'lodash';

import { MaybePromise } from '../util/type-utils';
import { RuleParameterReference } from './rule-parameters';
import { CADefinition } from './passthrough-handling-definitions';

/**
 * A ProxySetting is a specific proxy setting to use, which is passed to a proxy agent
 * who will manage creating a socket for the request (directly, or tunnelled, or whatever).
 */
export interface ProxySetting {
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

    /**
     * CAs to trust for HTTPS connections to the proxy. Ignored if the connection to
     * the proxy is not HTTPS. If not specified, this will default to the Node
     * defaults, or you can override them here completely.
     *
     * This sets the complete list of trusted CAs, and is mutually exclusive with the
     * `additionalTrustedCAs` option, which adds additional CAs (but also trusts the
     * Node default CAs too).
     *
     * This should be specified as either a { cert: string | Buffer } object or a
     * { certPath: string } object (to read the cert from disk). The previous
     * simple string format is supported but deprecated.
     */
    trustedCAs?: Array<
        | string // Deprecated
        | CADefinition
    >;

    /**
     * Extra CAs to trust for HTTPS connections to the proxy. Ignored if the connection
     * to the proxy is not HTTPS.
     *
     * This appends to the list of trusted CAs, and is mutually exclusive with the
     * `trustedCAs` option, which completely overrides the list of CAs.
     */
    additionalTrustedCAs?: Array<CADefinition>;
}

/**
 * A ProxySettingSource is a way to calculate the ProxySetting for a given request. It
 * may be a fixed ProxySetting value, or a callback to get ProxySetting values, or an
 * array of sources, which should be iterated to get the first usable value
 */
export type ProxySettingSource =
    | ProxySetting
    | ProxySettingCallback
    | Array<ProxySettingSource>
    | undefined;

export type ProxySettingCallbackParams = { hostname: string };
export type ProxySettingCallback = (params: ProxySettingCallbackParams) => MaybePromise<ProxySetting | undefined>;

/**
 * A ProxyConfig is externally provided config that specifies a ProxySettingSource.
 * It might be a ProxySettingSource itself, or it might include references to rule
 * parameters, which must be dereferenced to make it usable as a ProxySettingSource.
 */
export type ProxyConfig =
 | ProxySettingSource
 | RuleParameterReference<ProxySettingSource>
 | Array<ProxySettingSource | RuleParameterReference<ProxySettingSource>>;

export async function getProxySetting(
    configSource: ProxySettingSource,
    params: ProxySettingCallbackParams
) {
    if (_.isFunction(configSource)) return configSource(params);
    else if (_.isArray(configSource)) {
        let result: ProxySetting | undefined;
        for (let configArrayOption of configSource) {
            result = await getProxySetting(configArrayOption, params);
            if (result) break;
        }
        return result;
    }
    else return configSource;
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
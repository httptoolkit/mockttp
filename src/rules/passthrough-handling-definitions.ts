import { ProxyConfig } from "./proxy-config";

export interface ForwardingOptions {
    targetHost: string,
    // Should the host (H1) or :authority (H2) header be updated to match?
    updateHostHeader?: true | false | string // Change automatically/ignore/change to custom value
}

export interface PassThroughLookupOptions {
    /**
     * The maximum time to cache a DNS response. Up to this limit,
     * responses will be cached according to their own TTL. Defaults
     * to Infinity.
     */
    maxTtl?: number;
    /**
     * How long to cache a DNS ENODATA or ENOTFOUND response. Defaults
     * to 0.15.
     */
    errorTtl?: number;
    /**
     * The primary servers to use. DNS queries will be resolved against
     * these servers first. If no data is available, queries will fall
     * back to dns.lookup, and use the OS's default DNS servers.
     *
     * This defaults to dns.getServers().
     */
    servers?: string[];
}

export type CADefinition =
    | { cert: string | Buffer }
    | { certPath: string };

/**
 * This defines the upstream connection parameters. These passthrough parameters
 * are shared between both WebSocket & Request passthrough rules.
 */
export interface PassThroughHandlerConnectionOptions {
    /**
     * The forwarding configuration for the passthrough rule.
     * This generally shouldn't be used explicitly unless you're
     * building rule data by hand. Instead, call `thenPassThrough`
     * to send data directly or `thenForwardTo` with options to
     * configure traffic forwarding.
     */
    forwarding?: ForwardingOptions,

    /**
     * A list of hostnames for which server certificate and TLS version errors
     * should be ignored (none, by default).
     *
     * If set to 'true', HTTPS errors will be ignored for all hosts. WARNING:
     * Use this at your own risk. Setting this to `true` can open your
     * application to MITM attacks and should never be used over any network
     * that is not completed trusted end-to-end.
     */
    ignoreHostHttpsErrors?: string[] | boolean;

    /**
     * An array of additional certificates, which should be trusted as certificate
     * authorities for upstream hosts, in addition to Node.js's built-in certificate
     * authorities.
     *
     * Each certificate should be an object with either a `cert` key and a string
     * or buffer value containing the PEM certificate, or a `certPath` key and a
     * string value containing the local path to the PEM certificate.
     */
    additionalTrustedCAs?: Array<CADefinition>;

    /**
     * Deprecated alias for `additionalTrustedCAs`
     *
     * @deprecated
     */
    trustAdditionalCAs?: Array<CADefinition>;

    /**
     * A mapping of hosts to client certificates to use, in the form of
     * `{ key, cert }` objects (none, by default)
     */
    clientCertificateHostMap?: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    /**
     * Upstream proxy configuration: pass through requests via this proxy.
     *
     * If this is undefined, no proxy will be used. To configure a proxy
     * provide either:
     * - a ProxySettings object
     * - a callback which will be called with an object containing the
     *   hostname, and must return a ProxySettings object or undefined.
     * - an array of ProxySettings or callbacks. The array will be
     *   processed in order, and the first not-undefined ProxySettings
     *   found will be used.
     *
     * When using a remote client, this parameter or individual array
     * values may be passed by reference, using the name of a rule
     * parameter configured in the admin server.
     */
    proxyConfig?: ProxyConfig;

    /**
     * Custom DNS options, to allow configuration of the resolver used
     * when forwarding requests upstream. Passing any option switches
     * from using node's default dns.lookup function to using the
     * cacheable-lookup module, which will cache responses.
     */
    lookupOptions?: PassThroughLookupOptions;

    /**
     * Whether to simulate connection errors back to the client.
     *
     * By default (in most cases - see below) when an upstream request fails
     * outright a 502 "Bad Gateway" response is sent to the downstream client,
     * explicitly indicating the failure and containing the error that caused
     * the issue in the response body.
     *
     * Only in the case of upstream HTTP connection reset errors is a connection
     * reset normally sent back downstream to existing clients (this behaviour
     * exists for backward compatibility, and will change to match other error
     * behaviour in a future version).
     *
     * When this option is set to `true`, low-level connection failures will
     * always trigger a downstream connection close/reset, rather than a 502
     * response.
     *
     * This includes DNS failures, TLS connection errors, TCP connection resets,
     * etc (but not HTTP non-200 responses, which are still proxied as normal).
     * This is less convenient for debugging in a testing environment or when
     * using a proxy intentionally, but can be more accurate when trying to
     * transparently proxy network traffic, errors and all.
     */
    simulateConnectionErrors?: boolean;
}
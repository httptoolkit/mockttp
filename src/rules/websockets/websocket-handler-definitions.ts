import * as _ from 'lodash';
import * as url from 'url';
import { stripIndent } from 'common-tags';

import {
    ClientServerChannel,
    Serializable,
    SerializedProxyConfig,
    serializeProxyConfig
} from "../../serialization/serialization";

import { Explainable, Headers } from "../../types";

import {
    CloseConnectionHandlerDefinition,
    TimeoutHandlerDefinition,
    ForwardingOptions,
    PassThroughLookupOptions
} from '../requests/request-handler-definitions';
import { ProxyConfig } from '../proxy-config';

/*
This file defines websocket handler *definitions*, which includes everything necessary to define
and serialize a websockt handler's behaviour, but doesn't include the actual handling logic (which
lives in ./websocket-handlers instead). This is intended to allow tree-shaking in browser usage
or remote clients to import only the necessary code, with no need to include all the real
network processing and handling code that is only used at HTTP-runtime, so isn't relevant when
defining rules.

Every WebSocketHandler extends its definition, simply adding a handle() method, which handles
requests according to the configuration, and adding a deserialize static method that takes
the serialized output from the serialize() methods defined here and creates a working handler.
*/

export interface WebSocketHandlerDefinition extends Explainable, Serializable {
    type: keyof typeof WsHandlerDefinitionLookup;
}

export interface PassThroughWebSocketHandlerOptions {
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
     */
    ignoreHostHttpsErrors?: string[];

    /**
     * An array of additional certificates, which should be trusted as certificate
     * authorities for upstream hosts, in addition to Node.js's built-in certificate
     * authorities.
     *
     * Each certificate should be an object with either a `cert` key and a string
     * or buffer value containing the PEM certificate, or a `certPath` key and a
     * string value containing the local path to the PEM certificate.
     */
    trustAdditionalCAs?: Array<{ cert: string | Buffer } | { certPath: string }>;

    /**
     * Upstream proxy configuration: pass through websockets via this proxy.
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
}

/**
 * @internal
 */
export interface SerializedPassThroughWebSocketData {
    type: 'ws-passthrough';
    forwarding?: ForwardingOptions;
    lookupOptions?: PassThroughLookupOptions;
    proxyConfig?: SerializedProxyConfig;
    ignoreHostCertificateErrors?: string[]; // Doesn't match option name, backward compat
    extraCACertificates?: Array<{ cert: string } | { certPath: string }>;
}

export class PassThroughWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {
    readonly type = 'ws-passthrough';

    // Same lookup configuration as normal request PassThroughHandler:
    public readonly lookupOptions: PassThroughLookupOptions | undefined;
    public readonly proxyConfig?: ProxyConfig;

    public readonly forwarding?: ForwardingOptions;
    public readonly ignoreHostHttpsErrors: string[] = [];

    public readonly extraCACertificates: Array<{ cert: string | Buffer } | { certPath: string }> = [];

    constructor(options: PassThroughWebSocketHandlerOptions = {}) {
        super();

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors ||
            [];
        if (!Array.isArray(this.ignoreHostHttpsErrors)) {
            throw new Error("ignoreHostHttpsErrors must be an array");
        }

        // If a location is provided, and it's not a bare hostname, it must be parseable
        const { forwarding } = options;
        if (forwarding && forwarding.targetHost.includes('/')) {
            const { protocol, hostname, port, path } = url.parse(forwarding.targetHost);
            if (path && path.trim() !== "/") {
                const suggestion = url.format({ protocol, hostname, port }) ||
                    forwarding.targetHost.slice(0, forwarding.targetHost.indexOf('/'));
                throw new Error(stripIndent`
                    URLs for forwarding cannot include a path, but "${forwarding.targetHost}" does. ${''
                    }Did you mean ${suggestion}?
                `);
            }
        }
        this.forwarding = options.forwarding;

        this.lookupOptions = options.lookupOptions;
        this.proxyConfig = options.proxyConfig;
    }

    explain() {
        return this.forwarding
            ? `forward the websocket to ${this.forwarding.targetHost}`
            : 'pass the request through to the target host';
    }

    /**
     * @internal
     */
    serialize(channel: ClientServerChannel): SerializedPassThroughWebSocketData {
        return {
            type: this.type,
            forwarding: this.forwarding,
            lookupOptions: this.lookupOptions,
            proxyConfig: serializeProxyConfig(this.proxyConfig, channel),
            ignoreHostCertificateErrors: this.ignoreHostHttpsErrors,
            extraCACertificates: this.extraCACertificates.map((certObject) => {
                // We use toString to make sure that buffers always end up as
                // as UTF-8 string, to avoid serialization issues. Strings are an
                // easy safe format here, since it's really all just plain-text PEM
                // under the hood.
                if ('cert' in certObject) {
                    return { cert: certObject.cert.toString('utf8') }
                } else {
                    return certObject;
                }
            }),
        };
    }
}

export class EchoWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {

    readonly type = 'ws-echo';

    explain(): string {
        return "echo all websocket messages";
    }
}

export class RejectWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {

    readonly type = 'ws-reject';

    constructor(
        public readonly statusCode: number,
        public readonly statusMessage: string = 'WebSocket rejected',
        public readonly headers: Headers = {},
        public readonly body: Buffer | string = ''
    ) {
        super();
    }

    explain() {
        return `explicitly reject the websocket upgrade with status ${this.statusCode}`;
    }

}

// These two work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export {
    CloseConnectionHandlerDefinition,
    TimeoutHandlerDefinition
};

export const WsHandlerDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketHandlerDefinition,
    'ws-echo': EchoWebSocketHandlerDefinition,
    'ws-reject': RejectWebSocketHandlerDefinition,
    'close-connection': CloseConnectionHandlerDefinition,
    'timeout': TimeoutHandlerDefinition
};
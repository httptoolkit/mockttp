import * as _ from 'lodash';
import * as url from 'url';
import { stripIndent } from 'common-tags';

import {
    ClientServerChannel,
    Serializable,
    SerializedProxyConfig,
    serializeProxyConfig,
    serializeBuffer
} from "../../serialization/serialization";

import { Explainable, Headers } from "../../types";

import { ProxyConfig } from '../proxy-config';
import {
    PassThroughHandlerConnectionOptions,
    ForwardingOptions,
    PassThroughLookupOptions,
    CADefinition
} from '../passthrough-handling-definitions';
import {
    CloseConnectionHandlerDefinition,
    ResetConnectionHandlerDefinition,
    TimeoutHandlerDefinition
} from '../requests/request-handler-definitions';

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

export type PassThroughWebSocketHandlerOptions = PassThroughHandlerConnectionOptions;

/**
 * @internal
 */
export interface SerializedPassThroughWebSocketData {
    type: 'ws-passthrough';
    forwarding?: ForwardingOptions;
    lookupOptions?: PassThroughLookupOptions;
    proxyConfig?: SerializedProxyConfig;
    simulateConnectionErrors?: boolean;
    ignoreHostCertificateErrors?: string[] | boolean; // Doesn't match option name, backward compat
    extraCACertificates?: Array<{ cert: string } | { certPath: string }>;
    clientCertificateHostMap?: { [host: string]: { pfx: string, passphrase?: string } };
}

export class PassThroughWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {
    readonly type = 'ws-passthrough';

    // Same lookup configuration as normal request PassThroughHandler:
    public readonly lookupOptions: PassThroughLookupOptions | undefined;
    public readonly proxyConfig?: ProxyConfig;
    public readonly simulateConnectionErrors: boolean;

    public readonly forwarding?: ForwardingOptions;
    public readonly ignoreHostHttpsErrors: string[] | boolean = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly extraCACertificates: Array<CADefinition> = [];

    constructor(options: PassThroughWebSocketHandlerOptions = {}) {
        super();

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

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors || [];
        if (!Array.isArray(this.ignoreHostHttpsErrors) && typeof this.ignoreHostHttpsErrors !== 'boolean') {
            throw new Error("ignoreHostHttpsErrors must be an array or a boolean");
        }

        this.lookupOptions = options.lookupOptions;
        this.proxyConfig = options.proxyConfig;
        this.simulateConnectionErrors = !!options.simulateConnectionErrors;

        this.extraCACertificates =
            options.additionalTrustedCAs ||
            options.trustAdditionalCAs ||
            [];
        this.clientCertificateHostMap = options.clientCertificateHostMap || {};
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
            simulateConnectionErrors: this.simulateConnectionErrors,
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
            clientCertificateHostMap: _.mapValues(this.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: serializeBuffer(pfx), passphrase })
            )
        };
    }
}

export class EchoWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {

    readonly type = 'ws-echo';

    explain(): string {
        return "echo all websocket messages";
    }
}

export class ListenWebSocketHandlerDefinition extends Serializable implements WebSocketHandlerDefinition {

    readonly type = 'ws-listen';

    explain(): string {
        return "silently accept websocket messages without responding";
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

// These three work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export {
    CloseConnectionHandlerDefinition,
    ResetConnectionHandlerDefinition,
    TimeoutHandlerDefinition
};

export const WsHandlerDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketHandlerDefinition,
    'ws-echo': EchoWebSocketHandlerDefinition,
    'ws-listen': ListenWebSocketHandlerDefinition,
    'ws-reject': RejectWebSocketHandlerDefinition,
    'close-connection': CloseConnectionHandlerDefinition,
    'reset-connection': ResetConnectionHandlerDefinition,
    'timeout': TimeoutHandlerDefinition
};

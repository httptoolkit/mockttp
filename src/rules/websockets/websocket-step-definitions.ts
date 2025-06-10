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
    PassThroughStepConnectionOptions,
    ForwardingOptions,
    PassThroughLookupOptions,
    CADefinition,
    PassThroughInitialTransforms
} from '../passthrough-handling-definitions';
import {
    CloseConnectionStep,
    DelayStep,
    ResetConnectionStep,
    TimeoutStep
} from '../requests/request-step-definitions';
import { Replace } from '../../util/type-utils';
import { SerializedMatchReplacePairs, serializeMatchReplaceConfiguration } from '../match-replace';

/*
This file defines websocket step *definitions*, which includes everything necessary to define
and serialize a websocket step's behaviour, but doesn't include the actual handling logic (which
lives in the Impl classes ./websocket-steps instead). This is intended to allow tree-shaking
in browser usage or remote clients, importing only the necessary code, with no need to include
all the real request-processing and handling code that is only used at HTTP-runtime, so isn't
relevant when defining rules.

Every WebSocketStepImpl extends its definition, simply adding a handle() method, which handles
requests according to the configuration, and adding a deserialize static method that takes
the serialized output from the serialize() methods defined here and creates a working step.
*/

/**
 * The definition of a websocket rule step, which can be passed to Mockttp to define
 * a rule.
 *
 * Implementation of the step is not included in the definition classes, but
 * instead exists in an *Impl class defined separately and used internally.
 */
export interface WebSocketStepDefinition extends Explainable, Serializable {
    type: keyof typeof WsStepDefinitionLookup;
}

export interface PassThroughWebSocketStepOptions extends PassThroughStepConnectionOptions {

    transformRequest?: WebSocketRequestTransform;

}

export interface WebSocketRequestTransform extends PassThroughInitialTransforms {

    /**
     * Override the request protocol. If replaceHost & matchReplaceHost are not specified
     * and the URL no explicitly specified port, this will automatically switch to the
     * appropriate port (e.g. from 80 to 443).
     */
    setProtocol?: 'ws' | 'wss';

}

/**
 * @internal
 */
export interface SerializedPassThroughWebSocketData {
    type: 'ws-passthrough';
    forwarding?: ForwardingOptions; // API backward compat
    lookupOptions?: PassThroughLookupOptions;
    proxyConfig?: SerializedProxyConfig;
    simulateConnectionErrors?: boolean;
    ignoreHostCertificateErrors?: string[] | boolean; // Doesn't match option name, backward compat
    extraCACertificates?: Array<{ cert: string } | { certPath: string }>;
    clientCertificateHostMap?: { [host: string]: { pfx: string, passphrase?: string } };

    transformRequest?: Replace<WebSocketRequestTransform, {
        'matchReplaceHost'?: {
            replacements: SerializedMatchReplacePairs,
            updateHostHeader?: boolean | string
        },
        'matchReplacePath'?: SerializedMatchReplacePairs,
        'matchReplaceQuery'?: SerializedMatchReplacePairs
    }>,
}

export class PassThroughWebSocketStep extends Serializable implements WebSocketStepDefinition {

    readonly type = 'ws-passthrough';
    static readonly isFinal = true;

    // Same lookup configuration as normal request PassThroughStep:
    public readonly lookupOptions: PassThroughLookupOptions | undefined;
    public readonly proxyConfig?: ProxyConfig;
    public readonly simulateConnectionErrors: boolean;

    public readonly ignoreHostHttpsErrors: string[] | boolean = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly extraCACertificates: Array<CADefinition> = [];

    public readonly transformRequest?: WebSocketRequestTransform;

    constructor(options: PassThroughWebSocketStepOptions = {}) {
        super();

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors || [];
        if (!Array.isArray(this.ignoreHostHttpsErrors) && typeof this.ignoreHostHttpsErrors !== 'boolean') {
            throw new Error("ignoreHostHttpsErrors must be an array or a boolean");
        }

        this.lookupOptions = options.lookupOptions;
        this.proxyConfig = options.proxyConfig;
        this.simulateConnectionErrors = !!options.simulateConnectionErrors;

        this.extraCACertificates = options.additionalTrustedCAs || [];
        this.clientCertificateHostMap = options.clientCertificateHostMap || {};

        if (options.transformRequest) {
            if (options.transformRequest.setProtocol && !['ws', 'wss'].includes(options.transformRequest.setProtocol)) {
                throw new Error(`Invalid request protocol "${options.transformRequest.setProtocol}" must be "ws" or "wss"`);
            }

            if ([
                options.transformRequest.replaceHost,
                options.transformRequest.matchReplaceHost
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one request host transform can be specified at a time");
            }

            if (options.transformRequest.replaceHost) {
                const { targetHost } = options.transformRequest.replaceHost;
                if (targetHost.includes('/')) {
                    throw new Error(`Request transform replacement hosts cannot include a path or protocol, but "${targetHost}" does`);
                }
            }

            if (options.transformRequest.matchReplaceHost) {
                const values = Object.values(options.transformRequest.matchReplaceHost.replacements);
                for (let replacementValue of values) {
                    if (replacementValue.includes('/')) {
                        throw new Error(`Request transform replacement hosts cannot include a path or protocol, but "${replacementValue}" does`);
                    }
                }
            }

            this.transformRequest = options.transformRequest;
        }
    }

    explain() {
        const { targetHost } = this.transformRequest?.replaceHost || {};
        return targetHost
            ? `forward the websocket to ${targetHost}`
            : 'pass the websocket through to the target host';
    }

    /**
     * @internal
     */
    serialize(channel: ClientServerChannel): SerializedPassThroughWebSocketData {
        return {
            type: this.type,
            ...this.transformRequest?.replaceHost ? {
                // Backward compat:
                forwarding: this.transformRequest?.replaceHost
            } : {},
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
            ),
            transformRequest: this.transformRequest ? {
                ...this.transformRequest,
                matchReplaceHost: !!this.transformRequest?.matchReplaceHost
                    ? {
                        ...this.transformRequest.matchReplaceHost,
                        replacements: serializeMatchReplaceConfiguration(this.transformRequest.matchReplaceHost.replacements)
                    }
                    : undefined,
                matchReplacePath: !!this.transformRequest?.matchReplacePath
                    ? serializeMatchReplaceConfiguration(this.transformRequest.matchReplacePath)
                    : undefined,
                matchReplaceQuery: !!this.transformRequest?.matchReplaceQuery
                    ? serializeMatchReplaceConfiguration(this.transformRequest.matchReplaceQuery)
                    : undefined
            } : undefined,
        };
    }
}

export class EchoWebSocketStep extends Serializable implements WebSocketStepDefinition {

    readonly type = 'ws-echo';
    static readonly isFinal = true;

    explain(): string {
        return "echo all websocket messages";
    }
}

export class ListenWebSocketStep extends Serializable implements WebSocketStepDefinition {

    readonly type = 'ws-listen';
    static readonly isFinal = true;

    explain(): string {
        return "silently accept websocket messages without responding";
    }
}

export class RejectWebSocketStep extends Serializable implements WebSocketStepDefinition {

    readonly type = 'ws-reject';
    static readonly isFinal = true;

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
    CloseConnectionStep,
    ResetConnectionStep,
    TimeoutStep,
    DelayStep
};

export const WsStepDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketStep,
    'ws-echo': EchoWebSocketStep,
    'ws-listen': ListenWebSocketStep,
    'ws-reject': RejectWebSocketStep,
    'close-connection': CloseConnectionStep,
    'reset-connection': ResetConnectionStep,
    'timeout': TimeoutStep,
    'delay': DelayStep
};

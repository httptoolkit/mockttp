import * as _ from 'lodash';
import { Duplex } from 'stream';
import { v4 as uuid } from "uuid";

import { MaybePromise } from '../util/type-utils';
import {
    dereferenceParam,
    isParamReference,
    MOCKTTP_PARAM_REF,
    RuleParameterReference,
    RuleParameters
} from '../rules/rule-parameters';
import type {
    ProxySetting,
    ProxySettingSource,
    ProxySettingCallbackParams,
    ProxyConfig
} from '../rules/proxy-config';

export function serialize<T extends Serializable>(
    obj: T,
    stream: Duplex
): SerializedValue<T> {
    const channel = new ClientServerChannel(stream);
    const data = obj.serialize(channel) as SerializedValue<T>;
    data.topicId = channel.topicId;
    return data;
}

export function deserialize<
    T extends SerializedValue<Serializable>,
    C extends {
        new(...args: any): any;
        deserialize(data: SerializedValue<any>, channel: ClientServerChannel, ruleParams: RuleParameters): any;
    }
>(
    data: T,
    stream: Duplex,
    ruleParams: RuleParameters,
    lookup: { [key: string]: C }
): InstanceType<C> {
    const type = <keyof typeof lookup> data.type;
    const channel = new ClientServerChannel(stream, data.topicId);

    const deserialized = lookup[type].deserialize(data, channel, ruleParams);

    // Wrap .dispose and ensure the channel is always disposed too.
    const builtinDispose = deserialized.dispose;
    deserialized.dispose = () => {
        builtinDispose();
        channel.dispose();
    };

    return deserialized;
}

export type SerializedValue<T> = T & { topicId: string };

// Serialized data = data + type + topicId on every prop/prop's array elements
export type Serialized<T> = {
    [K in keyof T]:
        T[K] extends string | undefined
            ? string | undefined
        : T[K] extends Array<unknown>
            ? Array<SerializedValue<T[K][0]>>
        : SerializedValue<T[K]>;
};

export abstract class Serializable {
    abstract type: string;

    /**
     * @internal
     */
    serialize(_channel: ClientServerChannel): unknown {
        // By default, we assume data is transferrable as-is
        return this;
    }

    /**
     * @internal
     */
    static deserialize(
        data: SerializedValue<any>,
        _channel: ClientServerChannel,
        _ruleParams: RuleParameters
    ): any {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, data);
    }

    // This rule is being unregistered. Any handlers who need to cleanup when they know
    // they're no longer in use should implement this and dispose accordingly.
    // Only deserialized rules are disposed - if the originating rule needs
    // disposing too, ping the channel and let it know.
    dispose(): void { }
}

interface Message {
    topicId?: string;
}

interface RequestMessage<R> {
    requestId?: string;
    action?: string;
    error?: Error;
    data?: R;
}

const DISPOSE_MESSAGE = { disposeChannel: true };

// Wraps another stream, ensuring that messages go only to the paired channel on the
// other client/server. In practice, each handler gets one end of these streams in
// their serialize/deserialize methods, and can use them to sync live data reliably.
export class ClientServerChannel extends Duplex {

    public readonly topicId: string;

    constructor(
        private rawStream: Duplex,
        topicId?: string
    ) {
        super({ objectMode: true });

        this.topicId = topicId || uuid();
        this.rawStream.on('error', this._onRawStreamError);
        this.rawStream.on('finish', this._onRawStreamFinish);
    }

    private _onRawStreamError = (error: Error) => {
        this.destroy(error);
    };

    private _onRawStreamFinish = () => {
        this.end();
    }

    /**
     * @internal @hidden
     */
    _write(message: Message, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        message.topicId = this.topicId;
        const chunk = JSON.stringify(message) + '\n';

        if (!this.rawStream.write(chunk, encoding)) {
            this.rawStream.once('drain', callback);
        } else {
            callback();
        }
    }

    _readFromRawStream = (rawData: any) => {
        const stringData: string = rawData.toString();
        stringData.split('\n').filter(d => !!d).forEach((rawDataLine) => {
            let data: Message;
            try {
                data = JSON.parse(rawDataLine);
            } catch (e) {
                console.log(e);
                console.log('Received unparseable message, dropping.', rawDataLine.toString());
                return;
            }

            if (data.topicId === this.topicId) {
                if (_.isEqual(_.omit(data, 'topicId'), DISPOSE_MESSAGE)) this.dispose(true);
                else this.push(data);
            }
        });
    }

    private reading = false;

    _read() {
        if (!this.reading) {
            this.rawStream.on('data', this._readFromRawStream);
            this.reading = true;
        }
    }

    request<T extends {}, R>(data: T): Promise<R>;
    request<T extends {}, R>(action: string, data: T): Promise<R>;
    request<T extends {}, R>(actionOrData: string | T, dataOrNothing?: T): Promise<R> {
        let action: string | undefined;
        let data: T;
        if (_.isString(actionOrData)) {
            action = actionOrData;
            data = dataOrNothing!;
        } else {
            data = actionOrData;
        }

        const requestId = uuid();

        return new Promise<R>((resolve, reject) => {
            const responseListener = (response: RequestMessage<R>) => {
                if (response.requestId === requestId) {
                    if (response.error) {
                        // Derialize error from plain object
                        reject(Object.assign(new Error(), { stack: undefined }, response.error));
                    } else {
                        resolve(response.data!);
                    }
                    this.removeListener('data', responseListener);
                }
            }

            const request: RequestMessage<T> = { data, requestId };
            if (action) request.action = action;

            this.write(request, (e) => {
                if (e) reject(e);
                else this.on('data', responseListener);
            });
        });
    }

    // Wait for requests from the other side, and respond to them
    onRequest<T, R>(cb: (request: T) => MaybePromise<R>): void;
    // Wait for requests with a specific { action: actionName } property, and respond
    onRequest<T, R>(
        actionName: string,
        cb: (request: T) => MaybePromise<R>
    ): void;
    onRequest<T, R>(
        cbOrAction: string | ((r: T) => MaybePromise<R>),
        cbOrNothing?: (request: T) => MaybePromise<R>
    ): void {
        let actionName: string | undefined;
        let cb: (request: T) => MaybePromise<R>;

        if (_.isString(cbOrAction)) {
            actionName = cbOrAction;
            cb = cbOrNothing!;
        } else {
            cb = cbOrAction;
        }

        this.on('data', async (request: RequestMessage<T>) => {
            const { requestId, action } = request;

            // Filter by actionName, if set
            if (actionName !== undefined && action !== actionName) return;

            try {
                const response = {
                    requestId,
                    data: await cb(request.data!)
                };
                if (!this.writable) return; // Response too slow - drop it
                this.write(response);
            } catch (error) {
                // Make the error serializable:
                error = _.pick(error, Object.getOwnPropertyNames(error));
                if (!this.writable) return; // Response too slow - drop it
                this.write({ requestId, error });
            }
        });
    }

    // Shuts down the channel. Only needs to be called on one side, the other side
    // will be shut down automatically when it receives DISPOSE_MESSAGE.
    dispose(disposeReceived: boolean = false) {
        this.on('error', () => {}); // Dispose is best effort - we don't care about errors

        // Only one side needs to send a dispose - we send first if we haven't seen one.
        if (!disposeReceived) this.end(DISPOSE_MESSAGE);
        else this.end();

        // Detach any remaining onRequest handlers:
        this.removeAllListeners('data');
        // Stop receiving upstream messages from the global stream:
        this.rawStream.removeListener('data', this._readFromRawStream);
        this.rawStream.removeListener('error', this._onRawStreamError);
        this.rawStream.removeListener('finish', this._onRawStreamFinish);
    }
}

export function serializeBuffer(buffer: Buffer): string {
    return buffer.toString('base64');
}

export function deserializeBuffer(buffer: string): Buffer {
    return Buffer.from(buffer, 'base64');
}

const SERIALIZED_PARAM_REFERENCE = "__mockttp__param__reference__";
export type SerializedRuleParameterReference<R> = { [SERIALIZED_PARAM_REFERENCE]: string };

function serializeParam<R>(value: RuleParameterReference<R>): SerializedRuleParameterReference<R> {
    // Swap the symbol for a string, since we can't serialize symbols in JSON:
    return { [SERIALIZED_PARAM_REFERENCE]: value[MOCKTTP_PARAM_REF] };
}

function isSerializedRuleParam(value: any): value is SerializedRuleParameterReference<unknown> {
    return value && SERIALIZED_PARAM_REFERENCE in value;
}

export function ensureParamsDeferenced<T>(
    value: T | SerializedRuleParameterReference<T>,
    ruleParams: RuleParameters
): T {
    if (isSerializedRuleParam(value)) {
        const paramRef = {
            [MOCKTTP_PARAM_REF]: value[SERIALIZED_PARAM_REFERENCE]
        };
        return dereferenceParam(paramRef, ruleParams);
    } else {
        return value;
    }
}

export type SerializedProxyConfig =
    | ProxySetting
    | string // Callback id on the serialization channel
    | undefined
    | SerializedRuleParameterReference<ProxySettingSource>
    | Array<SerializedProxyConfig>;

export function serializeProxyConfig(
    proxyConfig: ProxyConfig,
    channel: ClientServerChannel
): SerializedProxyConfig {
    if (_.isFunction(proxyConfig)) {
        const callbackId = `proxyConfig-callback-${uuid()}`;

        channel.onRequest<
            ProxySettingCallbackParams,
            ProxySetting | undefined
        >(callbackId, proxyConfig);

        return callbackId;
    } else if (_.isArray(proxyConfig)) {
        return proxyConfig.map((config) => serializeProxyConfig(config, channel));
    } else if (isParamReference(proxyConfig)) {
        return serializeParam(proxyConfig);
    } else if (proxyConfig) {
        return {
            ...proxyConfig,
            trustedCAs: proxyConfig.trustedCAs?.map((caDefinition) =>
                typeof caDefinition !== 'string' && 'cert' in caDefinition
                    ? { cert: caDefinition.cert.toString('utf8') } // Stringify in case of buffers
                    : caDefinition
            ),
            additionalTrustedCAs: proxyConfig.additionalTrustedCAs?.map((caDefinition) =>
                'cert' in caDefinition
                    ? { cert: caDefinition.cert.toString('utf8') } // Stringify in case of buffers
                    : caDefinition
            )
        };
    }
}

export function deserializeProxyConfig(
    proxyConfig: SerializedProxyConfig,
    channel: ClientServerChannel,
    ruleParams: RuleParameters
): ProxySettingSource {
    if (_.isString(proxyConfig)) {
        const callbackId = proxyConfig;

        const proxyConfigCallback = async (options: ProxySettingCallbackParams) => {
            return await channel.request<
                ProxySettingCallbackParams,
                ProxySetting | undefined
            >(callbackId, options);
        };
        return proxyConfigCallback;
    } else if (_.isArray(proxyConfig)) {
        return proxyConfig.map((config) => deserializeProxyConfig(config, channel, ruleParams));
    } else {
        return ensureParamsDeferenced(proxyConfig, ruleParams);
    }
}
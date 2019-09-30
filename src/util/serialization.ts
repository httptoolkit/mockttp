import * as _ from 'lodash';
import { Duplex } from 'stream';
import uuid = require('uuid/v4');
import { encode as encodeBase64 } from 'base64-arraybuffer';

import { MaybePromise, Replace, Omit } from './type-utils';
import { CompletedBody, Headers } from '../types';
import { buildBodyReader } from './request-utils';

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
        deserialize(data: SerializedValue<any>, channel: ClientServerChannel): any
    }
>(
    data: T,
    stream: Duplex,
    lookup: { [key: string]: C }
): InstanceType<C> {
    const type = <keyof typeof lookup> data.type;
    const channel = new ClientServerChannel(stream, data.topicId);

    const deserialized = lookup[type].deserialize(data, channel);

    // Wrap .dispose and ensure the channel is always disposed too.
    const builtinDispose = deserialized.dispose;
    deserialized.dispose = () => {
        builtinDispose();
        channel.dispose();
    };

    return deserialized;
}

type SerializedValue<T> = T & { topicId: string };

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

    serialize(_channel: ClientServerChannel): unknown {
        // By default, we assume data is transferrable as-is
        return this;
    }

    static deserialize(data: SerializedValue<any>, _channel: ClientServerChannel): any {
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
    }

    _write(message: Message, encoding: string, callback: (error?: Error | null) => void) {
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
                if (_.isEqual(data, DISPOSE_MESSAGE)) this.dispose();
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
                        resolve(response.data);
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
                this.write(response);
            } catch (error) {
                // Make the error serializable:
                error = _.pick(error, Object.getOwnPropertyNames(error));
                this.write({ requestId, error });
            }
        });
    }

    // Shuts down the channel. Only needs to be called on one side, the other side
    // will be shut down automatically when it receives DISPOSE_MESSAGE.
    dispose() {
        this.end(DISPOSE_MESSAGE);

        // Kill any remaining channel usage:
        this.removeAllListeners();
        // Stop receiving upstream messages from the global stream:
        this.rawStream.removeListener('data', this._readFromRawStream);
    }
}

export function serializeBuffer(buffer: Buffer): string {
    return buffer.toString('base64');
}

export function deserializeBuffer(buffer: string): Buffer {
    return Buffer.from(buffer, 'base64');
}

export function withSerializedBodyReader<T extends {
    body: CompletedBody
}>(input: T): Replace<T, 'body', string> {
    return Object.assign({}, input, { body: input.body.buffer.toString('base64') });
}

export function withDeserializedBodyReader<T extends { headers: Headers, body: CompletedBody }>(
    input: Replace<T, 'body', string>
): T {
    return <T> Object.assign({}, input as Omit<T, 'body'>, {
        body: buildBodyReader(deserializeBuffer(input.body), input.headers)
    })
}

export function withSerializedBodyBuffer<T extends {
    body?: CompletedBody | Buffer | ArrayBuffer | string
}>(input: T): Replace<T, 'body', string | undefined> {
    let serializedBody: string | undefined;

    if (!input.body) {
        serializedBody = undefined;
    } else if (_.isString(input.body)) {
        serializedBody = serializeBuffer(Buffer.from(input.body));
    } else if (_.isBuffer(input.body)) {
        serializedBody = serializeBuffer(input.body as Buffer);
    } else if (_.isArrayBuffer(input.body) || _.isTypedArray(input.body)) {
        serializedBody = encodeBase64(input.body as ArrayBuffer);
    } else if (input.body.hasOwnProperty('decodedBuffer')) {
        serializedBody = serializeBuffer(input.body.buffer);
    }

    return Object.assign({}, input, { body: serializedBody });
}

export type WithSerializedBodyBuffer<T extends { body?: any }> =
    Replace<T, 'body', string | undefined>;

export function withDeserializedBodyBuffer<T extends {
    headers?: Headers,
    body?: Buffer | string | undefined
}>(
    input: Replace<T, 'body', string | undefined>
): T {
    if (input.body === undefined) return input as T;

    return <T> Object.assign({}, input as Omit<T, 'body'>, {
        body: Buffer.from(input.body, 'base64')
    })
}
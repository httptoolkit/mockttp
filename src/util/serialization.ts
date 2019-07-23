import * as _ from 'lodash';
import { Duplex } from 'stream';
import uuid = require('uuid/v4');
import { MaybePromise } from './type-utils';

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
        T[K] extends Array<unknown>
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

interface RequestMessage {
    requestId?: string;
    error?: Error;
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
        const chunk = JSON.stringify(message);

        if (!this.rawStream.write(chunk, encoding)) {
            this.rawStream.once('drain', callback);
        } else {
            callback();
        }
    }

    _readFromRawStream = (rawData: any) => {
        let data: Message;
        try {
            data = JSON.parse(rawData);
        } catch (e) {
            console.log(e);
            console.log('Received unparseable message, dropping.', rawData.toString());
            return;
        }

        if (data.topicId === this.topicId) {
            if (_.isEqual(data, DISPOSE_MESSAGE)) this.dispose();
            else this.push(data);
        }
    }

    private reading = false;

    _read() {
        if (!this.reading) {
            this.rawStream.on('data', this._readFromRawStream);
            this.reading = true;
        }
    }

    request<T extends {}, R>(data: T & RequestMessage): Promise<R> {
        const requestId = uuid();

        return new Promise<R>((resolve, reject) => {
            const responseListener = (response: R & RequestMessage) => {
                if (response.requestId === requestId) {
                    if (response.error) {
                        reject(response.error);
                    } else {
                        resolve(response);
                    }
                    this.removeListener('data', responseListener);
                }
            }

            data.requestId = requestId;
            this.write(data, (e) => {
                if (e) reject(e);
                else this.on('data', responseListener);
            });
        });
    }

    onRequest<T, R>(cb: (request: T) => MaybePromise<R & RequestMessage>): void {
        this.on('data', async (request: T & RequestMessage) => {
            const { requestId } = request;
            try {
                const result = await cb(request);
                result.requestId = requestId;
                this.write(result);
            } catch (error) {
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

import * as _ from 'lodash';
import { Duplex } from 'stream';

export type SerializationOptions = {
    // Channel for two way communication with the original serializer
    clientStream?: Duplex;
}

export abstract class Serializable {
    abstract type: string;

    serialize(options?: SerializationOptions): any;
    serialize(): any {
        // By default, we assume data is transferrable as-is
        return this;
    }

    static deserialize(data: any, options?: SerializationOptions): any;
    static deserialize(data: any) {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, data);
    }
}

export function deserialize<T extends { type: string }>(
    data: T,
    lookup: { [key: string]: { deserialize(data: any, options?: SerializationOptions): any } },
    options: SerializationOptions = {}
): any {
    let type = <keyof typeof lookup> data.type;
    return lookup[type].deserialize(data, options);
}
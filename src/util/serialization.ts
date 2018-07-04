import * as _ from 'lodash';

export abstract class Serializable {
    serialize(): any {
        // By default, we assume data is transferrable as-is
        return this;
    }

    static deserialize(data: any) {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, data);
    }
}

export function deserialize<T extends { type: string }>(
    data: T, lookup: { [key: string]: { deserialize: (data: T) => any } }
): any {
    let type = <keyof typeof lookup> data.type;
    return lookup[type].deserialize(data);
}
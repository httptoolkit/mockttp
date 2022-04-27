import * as _ from 'lodash';
import { encode as encodeBase64 } from 'base64-arraybuffer';

import { CompletedBody, Headers } from "../types";
import { asBuffer } from "../util/buffer-utils";
import { buildBodyReader, isMockttpBody } from "../util/request-utils";
import { Replace } from "../util/type-utils";

import { deserializeBuffer, serializeBuffer } from "./serialization";

export function withSerializedBodyReader<T extends {
    body: CompletedBody
}>(input: T): Replace<T, { body: string }> {
    return {
        ...input,
        body: asBuffer(input.body.buffer).toString('base64')
    };
}

export function withDeserializedBodyReader<T extends { headers: Headers, body: CompletedBody }>(
    input: Replace<T, { body: string }>
): T {
    return {
        ...input,
        body: buildBodyReader(deserializeBuffer(input.body), input.headers)
    } as T;
}

export function withSerializedBodyBuffer<T extends {
    body?: CompletedBody | Buffer | ArrayBuffer | string
}>(input: T): Replace<T, { body: string | undefined }> {
    let serializedBody: string | undefined;

    if (!input.body) {
        serializedBody = undefined;
    } else if (_.isString(input.body)) {
        serializedBody = serializeBuffer(asBuffer(input.body));
    } else if (_.isBuffer(input.body)) {
        serializedBody = serializeBuffer(input.body as Buffer);
    } else if (_.isArrayBuffer(input.body) || _.isTypedArray(input.body)) {
        serializedBody = encodeBase64(input.body as ArrayBuffer);
    } else if (isMockttpBody(input.body)) {
        serializedBody = serializeBuffer(asBuffer(input.body.buffer));
    }

    return {
        ...input,
        body: serializedBody
    };
}

export type WithSerializedBodyBuffer<T extends { body?: any }> =
    Replace<T, { body: string | undefined }>;

export function withDeserializedBodyBuffer<T extends {
    headers?: Headers,
    body?: Buffer | string | undefined
}>(
    input: Replace<T, { body: string | undefined }>
): T {
    if (input.body === undefined) return input as T;

    return {
        ...input,
        body: input.body !== undefined
            ? Buffer.from(input.body, 'base64')
            : undefined
    } as T;
}
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

/**
 * Serialize a callback result (callback handlers, BeforeRequest/Response etc)
 * to transform all the many possible buffer formats into either base64-encoded
 * buffer data, or undefined.
 */
export function withSerializedCallbackBuffers<T extends {
    body?: CompletedBody | Buffer | Uint8Array | ArrayBuffer | string,
    rawBody?: Buffer | Uint8Array
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
        body: serializedBody,
        rawBody: input.rawBody
            ? serializeBuffer(asBuffer(input.rawBody))
            : undefined
    };
}

export type WithSerializedCallbackBuffers<T extends { body?: any }> =
    Replace<T, { body?: string, rawBody?: string }>;

/**
 * Deserialize a callback result (callback handlers, BeforeRequest/Response etc)
 * to build buffer data (or undefined) from the base64-serialized data
 * produced by withSerializedCallbackBuffers
 */
export function withDeserializedCallbackBuffers<T extends {
    body?: Buffer | Uint8Array | string,
    rawBody?: Buffer | Uint8Array
}>(
    input: Replace<T, { body?: string, rawBody?: string }>
): T {
    return {
        ...input,
        body: input.body !== undefined
            ? Buffer.from(input.body, 'base64')
            : undefined,
        rawBody: input.rawBody !== undefined
            ? Buffer.from(input.rawBody, 'base64')
            : undefined
    } as T;
}
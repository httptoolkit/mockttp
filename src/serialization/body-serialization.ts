import * as _ from 'lodash';
import { encode as encodeBase64 } from 'base64-arraybuffer';
import { MaybePromise, UnreachableCheck } from '@httptoolkit/util';

import { CompletedBody, Headers } from "../types";
import { asBuffer } from "../util/buffer-utils";
import { buildBodyReader, isMockttpBody } from "../util/request-utils";
import { Replace } from "../util/type-utils";

import { deserializeBuffer, serializeBuffer } from "./serialization";

export type SerializedBody =
    // Base64 string of encoded body, from 'none' body decoding option, or old servers:
    | string
    // Was encoded, now decoded successfully:
    | { encoded: string, decoded: string, decodingError: undefined }
    // Trivially known that no decoding was used:
    | { encoded: string, decoded: undefined, decodingError: undefined }
    // Was encoded, but decoding failed:
    | { encoded: string, decodingError: string, decoded: undefined };

// Server-side: serialize a body, so it can become a CompletedBody on the client side
export async function withSerializedBodyReader<T extends {
    headers: Headers,
    body: CompletedBody
}>(
    input: T,
    bodySerializer: BodySerializer
): Promise<Replace<T, { body: SerializedBody }>> {
    return {
        ...input,
        body: await bodySerializer(input.body, input.headers)
    };
}

export type BodySerializer = (body: CompletedBody, headers: Headers) => MaybePromise<SerializedBody>;

// Client-side: turn a serialized body back into a CompletedBody (body to be exposed for convenient access)
export function withDeserializedBodyReader<T extends { headers: Headers, body: CompletedBody }>(
    input: Replace<T, { body: SerializedBody }>
): T {
    let encodedBodyString: string;
    let decodedBodyString: string | undefined;
    let decodedBodyError: string | undefined;

    // We don't need to know the expected serialization format: we can detect it, and just
    // use what we get sensibly regardless:
    if (typeof input.body === 'string') {
        // If the body is a string, it is a base64-encoded string
        encodedBodyString = input.body;
    } else if (typeof input.body === 'object') {
        encodedBodyString = input.body.encoded;
        decodedBodyString = input.body.decoded;
        decodedBodyError = input.body.decodingError;
    } else {
        throw new UnreachableCheck(input.body);
    }


    return {
        ...input,
        body: deserializeBodyReader(encodedBodyString, decodedBodyString, decodedBodyError, input.headers),
    } as T;
}

export function deserializeBodyReader(
    encodedBodyString: string,
    decodedBodyString: string | undefined,
    decodingError: string | undefined,
    headers: Headers
): CompletedBody {
    const encodedBody = deserializeBuffer(encodedBodyString);
    const decodedBody = decodedBodyString ? deserializeBuffer(decodedBodyString) : undefined;

    const decoder = !!decodedBody
        // If the server provides a pre-decoded body, we use it.
        ? async () => decodedBody
        // If not, all encoded bodies are non-decodeable on the client side. This should
        // only happen with messageBodyDecoding = 'none' (or with v4+ clients + <v4 servers).
        : failIfDecodingRequired.bind(null, decodingError);

    return buildBodyReader(encodedBody, headers, decoder);
}

function failIfDecodingRequired(errorMessage: string | undefined, buffer: Buffer, headers: Headers) {
    if (!headers['content-encoding'] || headers['content-encoding'] === 'identity') {
        return buffer;
    }

    const error = errorMessage
        ? new Error(`Decoding error (${headers['content-encoding']}): ${errorMessage}`)
        : new Error("Can't read encoded message body without server-side decoding");

    console.warn(error.message);

    throw error;
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
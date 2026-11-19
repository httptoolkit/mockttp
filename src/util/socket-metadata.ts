import { Buffer } from 'buffer';
import _ from 'lodash';

import { SocketMetadata } from './socket-extensions';

const METADATA_USERNAME = 'metadata';

function combineArrays(existingValue: unknown, newValue: unknown) {
    if (Array.isArray(existingValue) && Array.isArray(newValue)) {
        return _.union(existingValue, newValue);
    }
}

export function getSocketMetadata(existingMetadata: SocketMetadata | undefined = undefined, metadataInput: string | Buffer) {
    const firstChar = Buffer.isBuffer(metadataInput)
        ? String.fromCharCode(metadataInput[0])
        : metadataInput[0];

    // Base64'd json always starts with 'e' (typically eyI), so we can use this fairly
    // reliably to detect base64 (and to definitively exclude valid object JSON encoding).
    const decodedMetadata = firstChar === 'e'
        ? Buffer.from(metadataInput.toString('utf8'), 'base64url').toString('utf8')
        : metadataInput.toString('utf8');

    const jsonMetadata = JSON.parse(decodedMetadata);

    if (_.isPlainObject(jsonMetadata)) {
        return _.mergeWith({}, existingMetadata, jsonMetadata, combineArrays);
    } else {
        return existingMetadata;
    }
};

export function getSocketMetadataFromProxyAuth(socket: { [SocketMetadata]?: SocketMetadata }, proxyAuth: string) {
    const existingMetadata = socket[SocketMetadata];
    if (!proxyAuth) return existingMetadata;

    const basicAuthMatch = /^Basic +(\S+)$/i.exec(proxyAuth.trim());
    if (!basicAuthMatch) return existingMetadata;

    const authValue = Buffer.from(basicAuthMatch[1], 'base64').toString('utf8');
    const separatorIndex = authValue.indexOf(':');
    if (separatorIndex === -1) return existingMetadata;

    const username = authValue.slice(0, separatorIndex);
    if (username !== METADATA_USERNAME) return existingMetadata;
    const password = authValue.slice(separatorIndex + 1);

    try {
        return getSocketMetadata(existingMetadata, password);
    } catch (e) {
        // We just ignore unparseable metadata in proxy auth headers
        return existingMetadata;
    }
}

export function getSocketMetadataTags(metadata: SocketMetadata | undefined): string[] {
    const tags: unknown = metadata?.tags;
    if (!Array.isArray(tags)) return [];

    // Metadata is client-provided JSON, so tags aren't guaranteed to match the declared type
    return tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => `socket-metadata:${tag}`);
}
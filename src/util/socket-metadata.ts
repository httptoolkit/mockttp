import { Buffer } from 'buffer';
import * as _ from 'lodash';

import { SocketMetadata } from './socket-extensions';

const METADATA_USERNAME = 'metadata';

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

    if (jsonMetadata && typeof jsonMetadata === 'object') {
        return _.merge({}, existingMetadata, jsonMetadata);
    } else {
        return existingMetadata;
    }
};

export function getSocketMetadataFromProxyAuth(socket: { [SocketMetadata]?: SocketMetadata }, proxyAuth: string) {
    const existingMetadata = socket[SocketMetadata];
    if (!proxyAuth) return existingMetadata;

    const [authType, b64AuthValue] = proxyAuth.split(' ', 2);
    if (authType !== 'Basic') return existingMetadata;

    const authValue = Buffer.from(b64AuthValue, 'base64').toString('utf8');
    const [username] = authValue.split(':', 1);

    if (username !== METADATA_USERNAME) return existingMetadata;
    const password = authValue.slice(username.length + 1);

    try {
        return getSocketMetadata(existingMetadata, password);
    } catch (e) {
        // We just ignore unparseable metadata in proxy auth headers
        return existingMetadata;
    }
}
export function getSocketMetadataTags(metadata: SocketMetadata | undefined) {
    if (!metadata) return [];
    return (metadata.tags || []).map((tag: string) => `socket-metadata:${tag}`);
}
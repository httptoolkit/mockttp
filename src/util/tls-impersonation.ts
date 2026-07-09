import type * as tls from 'tls';
import type { TlsClientHelloMessage } from 'read-tls-client-hello';

import type { Connection } from '../rules/http-agents';

// We declare the bits of tls-impersonate we use locally, rather than importing its types,
// because it's an optional dep so might not be present (old Node CI).
export interface ImpersonateResult {
    tlsOptions: {
        secureContext: tls.SecureContext;
        ALPNProtocols?: string[];
        requestOCSP?: boolean;
    };
    unsupported: Array<{ kind: string, id: number, reason: string }>;
}

export interface ImpersonateOptions extends tls.SecureContextOptions {
    security?: 'secure' | 'insecure';
}

interface TlsImpersonate {
    isSupported(): boolean;
    impersonateFromClientHello(
        hello: TlsClientHelloMessage,
        options?: ImpersonateOptions
    ): ImpersonateResult;
}

let impersonateModule: TlsImpersonate | null | undefined;

/**
 * Load tls-impersonate, if it's usable on this runtime. It's an optional, native, Node-only module
 * (fully effective on Node 26.4+, usable with reduced fidelity from 24.15) and may be entirely
 * absent (unsupported platform/Node, or no native build). We tolerate all of that by disabling
 * mirroring, so callers fall back to Mockttp's default upstream fingerprint.
 *
 * This is only ever reached when mirroring is explicitly enabled, so if the module isn't usable we
 * warn once (including on older Node): the caller asked to mirror fingerprints and it won't happen.
 */
function loadImpersonate(): TlsImpersonate | null {
    if (impersonateModule !== undefined) return impersonateModule;

    try {
        const loaded = require('tls-impersonate') as TlsImpersonate;
        impersonateModule = loaded?.isSupported?.() ? loaded : null;
    } catch {
        impersonateModule = null;
    }

    if (!impersonateModule) {
        console.warn('TLS fingerprint mirroring is enabled but unavailable - ' +
            'upstream requests will use the default TLS fingerprint instead.');
    }

    return impersonateModule;
}

const impersonationCache = new WeakMap<Connection, ImpersonateResult | undefined>();

/**
 * Get (building & caching once per connection) a TLS SecureContext + connect options that
 * reproduce the inbound ClientHello, folding in the given context options (trusted CAs, client
 * cert). Returns undefined if impersonation is unavailable or fails, so callers fall back to
 * Mockttp's default upstream fingerprint.
 */
export function buildTlsImpersonationConfig(
    connection: Connection,
    hello: TlsClientHelloMessage,
    options: ImpersonateOptions
): ImpersonateResult | undefined {
    if (impersonationCache.has(connection)) return impersonationCache.get(connection);

    const impersonate = loadImpersonate();
    let result: ImpersonateResult | undefined;

    if (impersonate) {
        try {
            result = impersonate.impersonateFromClientHello(hello, options);
        } catch (e) {
            console.warn(`Failed to impersonate inbound TLS fingerprint: ${(e as Error).message}`);
        }
    }

    impersonationCache.set(connection, result);
    return result;
}

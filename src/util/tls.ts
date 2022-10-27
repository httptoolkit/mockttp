import * as _ from 'lodash';
import { v4 as uuid } from "uuid";
import * as forge from 'node-forge';

const { pki, md, util: { encode64 } } = forge;

import * as fs from './fs';

export type CAOptions = (HttpsOptions | HttpsPathOptions);

export interface HttpsOptions extends IAdditionalHttpsOptions {
    key: string;
    cert: string;
};

export interface HttpsPathOptions extends IAdditionalHttpsOptions {
    keyPath: string;
    certPath: string;
}

/**
 * @prop {number?} [keyLength] - Minimum key length when generating a CA.  Defaults to 2048.
 * @prop {string?} [defaultDomain] - The domain name that will be used in the certificate for incoming TLS connections which don't use SNI to request a specific domain.
 */
export interface IAdditionalHttpsOptions {
    keyLength?: number;
    defaultDomain?: string;
}

export type PEM = string | string[] | Buffer | Buffer[];

export type GeneratedCertificate = {
    key: string,
    cert: string,
    ca: string
};

/**
 * Generate a CA certificate for mocking HTTPS.
 *
 * Returns a promise, for an object with key and cert properties,
 * containing the generated private key and certificate in PEM format.
 *
 * These can be saved to disk, and their paths passed
 * as HTTPS options to a Mockttp server.
 */
export async function generateCACertificate(options: {
    commonName?: string,
    organizationName?: string,
    countryName?: string,
    bits?: number
} = {}) {
    options = _.defaults({}, options, {
        commonName: 'Mockttp Testing CA - DO NOT TRUST - TESTING ONLY',
        organizationName: 'Mockttp',
        countryName: 'XX', // ISO-3166-1 alpha-2 'unknown country' code
        bits: 2048,
    });

    const keyPair = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
        pki.rsa.generateKeyPair({ bits: options.bits }, (error, keyPair) => {
            if (error) reject(error);
            else resolve(keyPair);
        });
    });

    const cert = pki.createCertificate();
    cert.publicKey = keyPair.publicKey;
    cert.serialNumber = generateSerialNumber();

    cert.validity.notBefore = new Date();
    // Make it valid for the last 24h - helps in cases where clocks slightly disagree
    cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);

    cert.validity.notAfter = new Date();
    // Valid for the next year by default.
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

    cert.setSubject([
        // All of these are required for a fully valid CA cert that will be accepted when imported anywhere:
        { name: 'commonName', value: options.commonName },
        { name: 'countryName', value: options.countryName },
        { name: 'organizationName', value: options.organizationName }
    ]);

    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
    ]);

    // Self-issued too
    cert.setIssuer(cert.subject.attributes);

    // Self-sign the certificate - we're the root
    cert.sign(keyPair.privateKey, md.sha256.create());

    return {
        key: pki.privateKeyToPem(keyPair.privateKey),
        cert: pki.certificateToPem(cert)
    };
}

export function generateSPKIFingerprint(certPem: PEM) {
    let cert = pki.certificateFromPem(certPem.toString('utf8'));
    return encode64(
        pki.getPublicKeyFingerprint(cert.publicKey, {
            type: 'SubjectPublicKeyInfo',
            md: md.sha256.create(),
            encoding: 'binary'
        })
    );
}

// Generates a unique serial number for a certificate as a hex string:
function generateSerialNumber() {
    return 'A' + uuid().replace(/-/g, '');
    // We add a leading 'A' to ensure it's always positive (not 'F') and always
    // valid (e.g. leading 000 is bad padding, and would be unparseable).
}

export async function getCA(options: CAOptions): Promise<CA> {
    let httpsOptions: HttpsOptions;
    if ((<any>options).key && (<any>options).cert) {
        httpsOptions = <HttpsOptions> options;
    }
    else if ((<any>options).keyPath && (<any>options).certPath) {
        let pathOptions = <HttpsPathOptions> options;
        httpsOptions = await Promise.all([
            fs.readFile(pathOptions.keyPath, 'utf8'),
            fs.readFile(pathOptions.certPath, 'utf8')
        ]).then(([ keyContents, certContents ]) => ({
            key: keyContents,
            cert: certContents,
            keyLength: pathOptions.keyLength
        }));
    }
    else {
        throw new Error('Unrecognized https options: you need to provide either a keyPath & certPath, or a key & cert.')
    }

    return new CA(httpsOptions.key, httpsOptions.cert, httpsOptions.keyLength || 2048);
}

// We share a single keypair across all certificates in this process, and
// instantiate it once when the first CA is created, because it can be
// expensive (depending on the key length).
// This would be a terrible idea for a real server, but for a mock server
// it's ok - if anybody can steal this, they can steal the CA cert anyway.
let KEY_PAIR: {
    publicKey: forge.pki.rsa.PublicKey,
    privateKey: forge.pki.rsa.PrivateKey,
    length: number
} | undefined;

export class CA {
    private caCert: forge.pki.Certificate;
    private caKey: forge.pki.PrivateKey;

    private certCache: { [domain: string]: GeneratedCertificate };

    constructor(
        caKey: PEM,
        caCert: PEM,
        keyLength: number
    ) {
        this.caKey = pki.privateKeyFromPem(caKey.toString('utf8'));
        this.caCert = pki.certificateFromPem(caCert.toString('utf8'));
        this.certCache = {};

        if (!KEY_PAIR || KEY_PAIR.length < keyLength) {
            // If we have no key, or not a long enough one, generate one.
            KEY_PAIR = Object.assign(
                pki.rsa.generateKeyPair(keyLength),
                { length: keyLength }
            );
        }
    }

    generateCertificate(domain: string): GeneratedCertificate {
        // TODO: Expire domains from the cache? Based on their actual expiry?
        if (this.certCache[domain]) return this.certCache[domain];

        if (domain.includes('_')) {
            // TLS certificates cannot cover domains with underscores, bizarrely. More info:
            // https://www.digicert.com/kb/ssl-support/underscores-not-allowed-in-fqdns.htm
            // To fix this, we use wildcards instead. This is only possible for one level of
            // certificate, and only for subdomains, so our options are a little limited, but
            // this should be very rare (because it's not supported elsewhere either).
            const [ , ...otherParts] = domain.split('.');
            if (
                otherParts.length <= 1 || // *.com is never valid
                otherParts.some(p => p.includes('_'))
            ) {
                throw new Error(`Cannot generate certificate for domain due to underscores: ${domain}`);
            }

            // Replace the first part with a wildcard to solve the problem:
            domain = `*.${otherParts.join('.')}`;
        }

        let cert = pki.createCertificate();

        cert.publicKey = KEY_PAIR!.publicKey;
        cert.serialNumber = generateSerialNumber();

        cert.validity.notBefore = new Date();
        // Make it valid for the last 24h - helps in cases where clocks slightly disagree.
        cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);

        cert.validity.notAfter = new Date();
        // Valid for the next year by default. TODO: Shorten (and expire the cache) automatically.
        cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

        cert.setSubject([
            ...(domain[0] === '*'
                ? [] // We skip the CN (deprecated, rarely used) for wildcards, since they can't be used here.
                : [{ name: 'commonName', value: domain }]
            ),
            { name: 'countryName', value: 'XX' }, // ISO-3166-1 alpha-2 'unknown country' code
            { name: 'localityName', value: 'Unknown' },
            { name: 'organizationName', value: 'Mockttp Cert - DO NOT TRUST' }
        ]);
        cert.setIssuer(this.caCert.subject.attributes);

        const policyList = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
                forge.asn1.create(
                    forge.asn1.Class.UNIVERSAL,
                    forge.asn1.Type.OID,
                    false,
                    forge.asn1.oidToDer('2.5.29.32.0').getBytes() // Mark all as Domain Verified
                )
            ])
        ]);

        cert.setExtensions([
            { name: 'basicConstraints', cA: false, critical: true },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
            { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
            {
                name: 'subjectAltName',
                altNames: [{
                    type: 2,
                    value: domain
                }]
            },
            { name: 'certificatePolicies', value: policyList },
            { name: 'subjectKeyIdentifier' },
            {
                name: 'authorityKeyIdentifier',
                // We have to calculate this ourselves due to
                // https://github.com/digitalbazaar/forge/issues/462
                keyIdentifier: (
                    this.caCert as any // generateSubjectKeyIdentifier is missing from node-forge types
                ).generateSubjectKeyIdentifier().getBytes()
            }
        ]);

        cert.sign(this.caKey, md.sha256.create());

        const generatedCertificate = {
            key: pki.privateKeyToPem(KEY_PAIR!.privateKey),
            cert: pki.certificateToPem(cert),
            ca: pki.certificateToPem(this.caCert)
        };

        this.certCache[domain] = generatedCertificate;
        return generatedCertificate;
    }
}
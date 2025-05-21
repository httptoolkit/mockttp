import * as _ from 'lodash';
import * as fs from 'fs/promises';
import { v4 as uuid } from "uuid";

import * as x509 from '@peculiar/x509';
import * as asn1X509 from '@peculiar/asn1-x509';
import * as asn1Schema from '@peculiar/asn1-schema';

import * as forge from 'node-forge';
const { asn1, pki, md, util } = forge;

const crypto = globalThis.crypto;

export type CAOptions = (CertDataOptions | CertPathOptions);

export interface CertDataOptions extends BaseCAOptions {
    key: string;
    cert: string;
};

export interface CertPathOptions extends BaseCAOptions {
    keyPath: string;
    certPath: string;
}

export interface BaseCAOptions {
    /**
     * Minimum key length when generating certificates. Defaults to 2048.
     */
    keyLength?: number;

    /**
     * The countryName that will be used in the certificate for incoming TLS
     * connections.
     */
    countryName?: string;

    /**
     * The localityName that will be used in the certificate for incoming TLS
     * connections.
     */
    localityName?: string;

    /**
     * The organizationName that will be used in the certificate for incoming TLS
     * connections.
     */
    organizationName?: string;
}

export type PEM = string | string[] | Buffer | Buffer[];

export type GeneratedCertificate = {
    key: string,
    cert: string,
    ca: string
};

const SUBJECT_NAME_MAP: { [key: string]: string } = {
    commonName: "CN",
    organizationName: "O",
    organizationalUnitName: "OU",
    countryName: "C",
    localityName: "L",
    stateOrProvinceName: "ST",
    domainComponent: "DC",
    serialNumber: "2.5.4.5"
};

function arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
    const base64 = Buffer.from(buffer).toString('base64');
    const lines = base64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

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
    subject?: {
        commonName?: string,
        organizationName?: string,
        countryName?: string,
        [key: string]: string | undefined // Add any other subject field you like
    },
    bits?: number,
    nameConstraints?: {
        /**
         * Array of permitted domains
         */
        permitted?: string[]
    }
} = {}) {
    options = {
        bits: 2048,
        ...options,
        subject: {
            commonName: 'Mockttp Testing CA - DO NOT TRUST - TESTING ONLY',
            organizationName: 'Mockttp',
            countryName: 'XX', // ISO-3166-1 alpha-2 'unknown country' code
            ...options.subject
        },
    };

    // We use RSA for now for maximum compatibility
    const keyAlgorithm = {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: options.bits,
        publicExponent: new Uint8Array([1, 0, 1]), // Standard 65537 fixed value
        hash: "SHA-256"
    };

    const keyPair = await crypto.subtle.generateKey(
        keyAlgorithm,
        true, // Key should be extractable to be exportable
        ["sign", "verify"]
    ) as CryptoKeyPair;

    // Baseline requirements set a specific order for standard CA fields:
    const orderedKeys = ["countryName", "organizationName", "organizationalUnitName", "commonName"];
    const subjectNameParts: x509.JsonNameParams = [];

    for (const key of orderedKeys) {
        const value = options.subject![key];
        if (!value) continue;
        const mappedKey = SUBJECT_NAME_MAP[key] || key;
        subjectNameParts.push({ [mappedKey]: [value] });
    }
    for (const key in options.subject) {
        if (orderedKeys.includes(key)) continue; // Already added above
        const value = options.subject[key]!;
        const mappedKey = SUBJECT_NAME_MAP[key] || key;
        subjectNameParts.push({ [mappedKey]: [value] });
    }
    const subjectDistinguishedName = new x509.Name(subjectNameParts).toString();

    const notBefore = new Date();
    // Make it valid for the last 24h - helps in cases where clocks slightly disagree
    notBefore.setDate(notBefore.getDate() - 1);

    const notAfter = new Date();
    // Valid for the next 10 years by default (BR sets an 8 year minimum)
    notAfter.setFullYear(notAfter.getFullYear() + 10);

    const extensions: x509.Extension[] = [
        new x509.BasicConstraintsExtension(
            true, // cA = true
            undefined, // We don't set any path length constraint (should we? Not required by BR)
            true
        ),
        new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.keyCertSign |
            x509.KeyUsageFlags.digitalSignature |
            x509.KeyUsageFlags.cRLSign,
            true
        ),
        await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey as CryptoKey, false),
        await x509.AuthorityKeyIdentifierExtension.create(keyPair.publicKey as CryptoKey, false)
    ];

    const permittedDomains = options.nameConstraints?.permitted || [];
    if (permittedDomains.length > 0) {
        const permittedSubtrees = permittedDomains.map(domain => {
            const generalName = new asn1X509.GeneralName({ dNSName: domain });
            return new asn1X509.GeneralSubtree({ base: generalName });
        });
        const nameConstraints = new asn1X509.NameConstraints({
            permittedSubtrees: new asn1X509.GeneralSubtrees(permittedSubtrees)
        });
        extensions.push(new x509.Extension(
            asn1X509.id_ce_nameConstraints,
            true,
            asn1Schema.AsnConvert.serialize(nameConstraints))
        );
    }

    const certificate = await x509.X509CertificateGenerator.create({
        serialNumber: generateSerialNumber(),
        subject: subjectDistinguishedName,
        issuer: subjectDistinguishedName, // Self-signed
        notBefore,
        notAfter,
        signingAlgorithm: keyAlgorithm,
        publicKey: keyPair.publicKey as CryptoKey,
        signingKey: keyPair.privateKey as CryptoKey,
        extensions
    });

    const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey as CryptoKey);
    const privateKeyPem = arrayBufferToPem(privateKeyBuffer, "RSA PRIVATE KEY");
    const certificatePem = certificate.toString("pem");

    return {
        key: privateKeyPem,
        cert: certificatePem
    };
}


export function generateSPKIFingerprint(certPem: PEM) {
    let cert = pki.certificateFromPem(certPem.toString('utf8'));
    return util.encode64(
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
    let certOptions: CertDataOptions;
    if ('key' in options && 'cert' in options) {
        certOptions = options;
    }
    else if ('keyPath' in options && 'certPath' in options) {
        certOptions = await Promise.all([
            fs.readFile(options.keyPath, 'utf8'),
            fs.readFile(options.certPath, 'utf8')
        ]).then(([ keyContents, certContents ]) => ({
            ..._.omit(options, ['keyPath', 'certPath']),
            key: keyContents,
            cert: certContents
        }));
    }
    else {
        throw new Error('Unrecognized https options: you need to provide either a keyPath & certPath, or a key & cert.')
    }

    return new CA(certOptions);
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
    private options: CertDataOptions;

    private certCache: { [domain: string]: GeneratedCertificate };

    constructor(options: CertDataOptions) {
        this.caKey = pki.privateKeyFromPem(options.key.toString());
        this.caCert = pki.certificateFromPem(options.cert.toString());
        this.certCache = {};
        this.options = options ?? {};

        const keyLength = options.keyLength || 2048;

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
            { name: 'countryName', value: this.options?.countryName ?? 'XX' }, // ISO-3166-1 alpha-2 'unknown country' code
            { name: 'localityName', value: this.options?.localityName ?? 'Unknown' },
            { name: 'organizationName', value: this.options?.organizationName ?? 'Mockttp Cert - DO NOT TRUST' }
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
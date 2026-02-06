import { Buffer } from 'buffer';
import * as fs from 'fs/promises';

import * as _ from 'lodash';

import * as x509 from '@peculiar/x509';
import * as asn1X509 from '@peculiar/asn1-x509';
import * as asn1Schema from '@peculiar/asn1-schema';

// Import for PKCS#8 structure
import { PrivateKeyInfo } from '@peculiar/asn1-pkcs8';

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
    ca: string,
    expiresAt: Date
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

// OID for rsaEncryption - used to wrap PKCS#1 keys into PKCS#8 below:
const rsaEncryptionOid = "1.2.840.113549.1.1.1";

async function pemToCryptoKey(pem: string) {
    // The PEM might be PKCS#8 ("BEGIN PRIVATE KEY") or PKCS#1 ("BEGIN
    // RSA PRIVATE KEY"). We want to transparently accept both, but
    // we can only import PKCS#8, so we detect & convert if required.

    const keyData = x509.PemConverter.decodeFirst(pem);
    let pkcs8KeyData: ArrayBuffer;

    try {
        // Try to parse the PEM as PKCS#8 PrivateKeyInfo - if it works,
        // we can just use it directly as-is:
        asn1Schema.AsnConvert.parse(keyData, PrivateKeyInfo);
        pkcs8KeyData = keyData;
    } catch (e: any) {
        // If parsing as PKCS#8 fails, assume it's PKCS#1 (RSAPrivateKey)
        // and proceed to wrap it as an RSA key in a PrivateKeyInfo structure.
        const rsaPrivateKeyDer = keyData;

        try {
            const privateKeyInfo = new PrivateKeyInfo({
                version: 0,
                privateKeyAlgorithm: new asn1X509.AlgorithmIdentifier({
                    algorithm: rsaEncryptionOid
                }),
                privateKey: new asn1Schema.OctetString(rsaPrivateKeyDer)
            });
            pkcs8KeyData = asn1Schema.AsnConvert.serialize(privateKeyInfo);
        } catch (conversionError: any) {
            throw new Error(
                `Unsupported or malformed key format. Failed to parse as PKCS#8 with ${
                    e.message || e.toString()
                } and failed to convert to PKCS#1 with ${
                    conversionError.message || conversionError.toString()
                }`
            );
        }
    }

    return await crypto.subtle.importKey(
        "pkcs8", // N.b, pkcs1 is not supported, which is why we need the above
        pkcs8KeyData,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true, // Extractable
        ["sign"]
    );
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
    const privateKeyPem = arrayBufferToPem(privateKeyBuffer, "PRIVATE KEY");
    const certificatePem = certificate.toString("pem");

    return {
        key: privateKeyPem,
        cert: certificatePem
    };
}

export async function generateSPKIFingerprint(certPem: string): Promise<string> {
    const cert = new x509.X509Certificate(certPem);
    const hashBuffer = await crypto.subtle.digest('SHA-256', cert.publicKey.rawData);
    return Buffer.from(hashBuffer).toString('base64');
}

// Generates a unique serial number for a certificate as a hex string:
function generateSerialNumber() {
    return 'A' + crypto.randomUUID().replace(/-/g, '');
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

    const caCert = new x509.X509Certificate(certOptions.cert.toString());
    const caKey = await pemToCryptoKey(certOptions.key.toString());

    return new CA(caCert, caKey, options);
}

// We share a single keypair across all certificates in this process, and
// instantiate it once when the first CA is created, because it can be
// expensive (depending on the key length).
// This would be a terrible idea for a real server, but for a mock server
// it's ok - if anybody can steal this, they can steal the CA cert anyway.
let KEY_PAIR: {
    value: Promise<CryptoKeyPair>,
    length: number
} | undefined;
const KEY_PAIR_ALGO = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1])
};

export type { CA };

class CA {
    private options: BaseCAOptions;

    constructor(
        private caCert: x509.X509Certificate,
        private caKey: CryptoKey,
        options?: BaseCAOptions
    ) {
        this.options = options ?? {};

        const keyLength = this.options.keyLength || 2048;

        if (!KEY_PAIR || KEY_PAIR.length < keyLength) {
            // If we have no key, or not a long enough one, generate one.
            KEY_PAIR = {
                length: keyLength,
                value: crypto.subtle.generateKey(
                    { ...KEY_PAIR_ALGO, modulusLength: keyLength },
                    true,
                    ["sign", "verify"]
                )
            };
        }
    }

    async generateCertificate(domain: string): Promise<GeneratedCertificate> {
        const leafKeyPair = await KEY_PAIR!.value;

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

        const subjectJsonNameParams: x509.JsonNameParams = [];
        const subjectAttributes: Record<string, string> = {};

        if (domain[0] !== '*') { // Skip this for wildcards as CN cannot use them
            subjectAttributes['commonName'] = domain;
        }
        subjectAttributes['countryName'] = this.options.countryName ?? 'XX';
        // Most other subject attributes aren't allowed here by BR.

        // Apply BR-required order
        const orderedSubjectKeys = ["countryName", "organizationName", "localityName", "commonName"];
        for (const key of orderedSubjectKeys) {
            if (subjectAttributes[key]) {
                const mappedKey = SUBJECT_NAME_MAP[key] || key;
                subjectJsonNameParams.push({ [mappedKey]: [subjectAttributes[key]] });
            }
        }
        const subjectDistinguishedName = new x509.Name(subjectJsonNameParams).toString();
        const issuerDistinguishedName = this.caCert.subject;

        const notBefore = new Date();
        notBefore.setDate(notBefore.getDate() - 1); // Valid from 24 hours ago

        const notAfter = new Date();
        notAfter.setFullYear(notAfter.getFullYear() + 1); // Valid for 1 year

        const extensions: x509.Extension[] = [];
        extensions.push(new x509.BasicConstraintsExtension(false, undefined, true));
        extensions.push(new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
            true
        ));
        extensions.push(new x509.ExtendedKeyUsageExtension(
            [asn1X509.id_kp_serverAuth, asn1X509.id_kp_clientAuth],
            false
        ));

        extensions.push(new x509.SubjectAlternativeNameExtension(
            [{ type: "dns", value: domain }],
            false
        ));

        const policyInfo = new asn1X509.PolicyInformation({
            policyIdentifier: '2.23.140.1.2.1' // Domain validated
        });
        const certificatePoliciesValue = new asn1X509.CertificatePolicies([policyInfo]);
        extensions.push(new x509.Extension(
            asn1X509.id_ce_certificatePolicies,
            false,
            asn1Schema.AsnConvert.serialize(certificatePoliciesValue)
        ));

        // We don't include SubjectKeyIdentifierExtension as that's no longer recommended
        extensions.push(await x509.AuthorityKeyIdentifierExtension.create(this.caCert, false));

        const certificate = await x509.X509CertificateGenerator.create({
            serialNumber: generateSerialNumber(),
            subject: subjectDistinguishedName,
            issuer: issuerDistinguishedName,
            notBefore,
            notAfter,
            signingAlgorithm: KEY_PAIR_ALGO,
            publicKey: leafKeyPair.publicKey,
            signingKey: this.caKey,
            extensions
        });

        const generatedCertificate: GeneratedCertificate = {
            key: arrayBufferToPem(
                await crypto.subtle.exportKey("pkcs8", leafKeyPair.privateKey as CryptoKey),
                "PRIVATE KEY"
            ),
            cert: certificate.toString("pem"),
            ca: this.caCert.toString("pem"),
            expiresAt: notAfter
        };

        return generatedCertificate;
    }
}
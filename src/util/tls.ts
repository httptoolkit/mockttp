/**
 * @module TLS
 */

import * as _ from 'lodash';
import * as uuid from 'uuid/v4';
import * as forge from 'node-forge';

const { pki, md, util: { encode64 } } = forge;

import * as fs from './fs';

export type CAOptions = (HttpsOptions | HttpsPathOptions);

export type HttpsOptions = {
    key: string;
    cert: string;
    keyLength?: number;
};

export type HttpsPathOptions = {
    keyPath: string;
    certPath: string;
    keyLength?: number;
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
export async function generateCACertificate(options: { commonName?: string, bits?: number } = {}) {
    options = _.defaults({}, options, {
        commonName: 'Mockttp Testing CA - DO NOT TRUST - TESTING ONLY',
        bits: 2048
    });

    const keyPair = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
        pki.rsa.generateKeyPair({ bits: options.bits }, (error, keyPair) => {
            if (error) reject(error);
            else resolve(keyPair);
        });
    });

    const cert = pki.createCertificate();
    cert.publicKey = keyPair.publicKey;
    cert.serialNumber = uuid().replace(/-/g, '');

    cert.validity.notBefore = new Date();
    // Make it valid for the last 24h - helps in cases where clocks slightly disagree
    cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);

    cert.validity.notAfter = new Date();
    // Valid for the next year by default.
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

    cert.setSubject([{ name: 'commonName', value: options.commonName }]);

    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true
    }]);

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

    return new CA(httpsOptions.key, httpsOptions.cert, httpsOptions.keyLength || 1024);
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

        let cert = pki.createCertificate();

        cert.publicKey = KEY_PAIR!.publicKey;
        cert.serialNumber = uuid().replace(/-/g, '');

        cert.validity.notBefore = new Date();
        // Make it valid for the last 24h - helps in cases where clocks slightly disagree.
        cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);

        cert.validity.notAfter = new Date();
        // Valid for the next year by default. TODO: Shorten (and expire the cache) automatically.
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

        cert.setSubject([
            { name: 'commonName', value: domain },
            { name: 'organizationName', value: 'Mockttp Cert - DO NOT TRUST' }
        ]);
        cert.setIssuer(this.caCert.subject.attributes);

        cert.setExtensions([{
            name: 'keyUsage',
            keyCertSign: true,
            digitalSignature: true,
            nonRepudiation: true,
            keyEncipherment: true,
            dataEncipherment: true
        }, {
            name: 'subjectAltName',
            altNames: [{
                type: 2,
                value: domain
            }]
        }]);

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
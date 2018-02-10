import * as uuid from 'uuid/v4';
import { pki, md } from 'node-forge';

import * as fs from './fs';

export type CAOptions = HttpsOptions | HttpsPathOptions;

export type HttpsOptions = {
    key: string
    cert: string
};

export type HttpsPathOptions = {
    keyPath: string;
    certPath: string;
}

export type PEM = string | string[] | Buffer | Buffer[];

export type GeneratedCertificate = {
    key: string,
    cert: string,
    ca: string
};

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
            cert: certContents
        }));
    }
    else {
        throw new Error('Unrecognized https options: you need to provide either a keyPath & certPath, or a key & cert.')
    }

    return new CA(httpsOptions.key, httpsOptions.cert);
}

export class CA {
    // This is slightly slow (~100ms), so do it once upfront, not for
    // every separate CA or even cert.
    private static readonly KEYS = pki.rsa.generateKeyPair(1024);

    private caCert: { subject: any };
    private caKey: {};

    private certCache: { [domain: string]: GeneratedCertificate };

    constructor(
        caKey: PEM,
        caCert: PEM
    ) {
        this.caKey = pki.privateKeyFromPem(caKey);
        this.caCert = pki.certificateFromPem(caCert);
        this.certCache = {};
    }

    generateCertificate(domain: string): GeneratedCertificate {
        // TODO: Expire domains from the cache? Based on their actual expiry?
        if (this.certCache[domain]) return this.certCache[domain];

        let cert = pki.createCertificate();
        
        cert.publicKey = CA.KEYS.publicKey;
        cert.serialNumber = uuid().replace(/-/g, '');
    
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        // TODO: shorten this expiry
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    
        cert.setSubject([
            { name: 'commonName', value: domain },
            { name: 'organizationName', value: 'Mockttp Cert - DO NOT TRUST' }
        ]);
        cert.setIssuer(this.caCert.subject.attributes);
    
        cert.setExtensions([{
            name: 'basicConstraints',
            cA: true
        }, {
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
            key: pki.privateKeyToPem(CA.KEYS.privateKey),
            cert: pki.certificateToPem(cert),
            ca: pki.certificateToPem(this.caCert)
        };
        
        this.certCache[domain] = generatedCertificate;
        return generatedCertificate;
    }
}
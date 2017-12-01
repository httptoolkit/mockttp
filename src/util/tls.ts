import * as uuid from 'uuid/v4';
import { pki, md } from 'node-forge';

export type PEM = string | string[] | Buffer | Buffer[];

export type GeneratedCertificate = {
    key: string,
    cert: string
};

// This is slightly slow (~100ms), so do it once upfront, not for
// every separate CA or even cert.
const KEYS = pki.rsa.generateKeyPair(1024);

export class CA {
    private caCert: { subject: any };
    private caKey: {};
    private certKeys: { publicKey: {}, privateKey: {} };
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
        
        cert.publicKey = KEYS.publicKey;
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
            altNames: {
                type: 2,
                value: domain
            }
        }]);
    
        cert.sign(this.caKey, md.sha256.create());

        const generatedCertificate = {
            key: pki.privateKeyToPem(KEYS.privateKey),
            cert: pki.certificateToPem(cert)
        };
        
        this.certCache[domain] = generatedCertificate;
        return generatedCertificate;
    }
}
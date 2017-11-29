import * as uuid from 'uuid/v4';
import { pki, md } from 'node-forge';

export type PEM = string | string[] | Buffer | Buffer[];

export type GeneratedCertificate = {
    key: string,
    cert: string
};

export class CA {
    private caCert: { subject: any };
    private caKey: {};
    private certKeys: { publicKey: {}, privateKey: {} };

    constructor(
        caKey: PEM,
        caCert: PEM
    ) {
        this.caKey = pki.privateKeyFromPem(caKey);
        this.caCert = pki.certificateFromPem(caCert);
        this.certKeys = pki.rsa.generateKeyPair(1024);
    }

    generateCertificate(domain: string): GeneratedCertificate {
        let cert = pki.createCertificate();
        
        cert.publicKey = this.certKeys.publicKey;
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

        return {
            key: pki.privateKeyToPem(this.certKeys.privateKey),
            cert: pki.certificateToPem(cert)
        };
    }
}
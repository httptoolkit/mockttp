import { Buffer } from 'buffer';
import * as x509 from '@peculiar/x509';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';

import { getCA } from '../src/util/certificates';
import { expect, nodeOnly } from './test-utils';

nodeOnly(() => {
    describe("External CA issuer encoding", () => {
        for (const certificateTransparency of [false, true]) {
            it(`preserves the encoded CA name with CT ${certificateTransparency ? 'enabled' : 'disabled'}`, async () => {
                const keys = await crypto.subtle.generateKey(
                    { name: 'ECDSA', namedCurve: 'P-256' },
                    true,
                    ['sign', 'verify']
                );

                // ASCII text can legitimately use UTF8String, as OpenSSL-generated
                // names do. Converting this name to text loses that distinction.
                const name = new x509.Name([
                    { C: [{ printableString: 'GB' }] },
                    { O: [{ utf8String: 'Example Organization' }] },
                    { CN: [{ utf8String: 'Example Test CA' }] }
                ]);
                const root = await x509.X509CertificateGenerator.createSelfSigned({
                    name,
                    serialNumber: '01',
                    notBefore: new Date(Date.now() - 60_000),
                    notAfter: new Date(Date.now() + 86_400_000),
                    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
                    keys,
                    extensions: [
                        new x509.BasicConstraintsExtension(true, undefined, true),
                        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)
                    ]
                });
                const key = x509.PemConverter.encode(
                    await crypto.subtle.exportKey('pkcs8', keys.privateKey),
                    'PRIVATE KEY'
                );

                const ca = await getCA({ key, cert: root.toString('pem'), certificateTransparency });
                const leaf = new x509.X509Certificate((await ca.generateCertificate('localhost')).cert);
                const rootAsn = AsnConvert.parse(root.rawData, Certificate);
                const leafAsn = AsnConvert.parse(leaf.rawData, Certificate);

                expect(leaf.issuer).to.equal(root.subject);
                expect(Buffer.from(AsnConvert.serialize(leafAsn.tbsCertificate.issuer)))
                    .to.deep.equal(Buffer.from(AsnConvert.serialize(rootAsn.tbsCertificate.subject)));
                expect(await leaf.verify({ publicKey: root })).to.equal(true);
                expect(leaf.getExtension('1.3.6.1.4.1.11129.2.4.2') !== null)
                    .to.equal(certificateTransparency);
            });
        }
    });
});

import { Buffer } from 'buffer';
import * as nodeCrypto from 'crypto';
import * as asn1X509 from '@peculiar/asn1-x509';
import * as asn1Schema from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/x509';

const crypto = globalThis.crypto;

const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

const SCT_EXTENSION_OID = '1.3.6.1.4.1.11129.2.4.2';

// Backdate the SCT timestamp by 24h, matching the leaf cert's notBefore, so that
// a verifier whose clock lags ours doesn't reject the SCT as future-dated. The
// device log list's log 'usable' timestamp must be at least this far in the past
// too, so an SCT never predates the log becoming usable.
const SCT_TIMESTAMP_BACKDATE_MS = 24 * 60 * 60 * 1000;

// PKCS#8 template for a P-256 private key containing only the scalar.
// OpenSSL derives the public point on import. Structure:
// SEQUENCE { version 0, AlgorithmIdentifier { ecPublicKey, prime256v1 },
//   OCTET STRING { ECPrivateKey { version 1, OCTET STRING <32-byte scalar> } } }
const EC_PKCS8_PREFIX = Buffer.from([
    0x30, 0x41,       // SEQUENCE (65 bytes)
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x13,       // SEQUENCE (19 bytes) - AlgorithmIdentifier
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
    0x04, 0x27,       // OCTET STRING (39 bytes) - wrapping ECPrivateKey
    0x30, 0x25,       // SEQUENCE (37 bytes) - ECPrivateKey
    0x02, 0x01, 0x01, // INTEGER 1 (version)
    0x04, 0x20        // OCTET STRING (32 bytes) - private scalar follows
]);

/**
 * A CT log operator with a derived P-256 keypair. Holds the private key for
 * signing SCTs and the public key / logId for verification.
 */
export class CTLogOperator {
    constructor(
        private readonly privateKey: nodeCrypto.KeyObject,
        public readonly publicKey: Buffer, // SPKI DER
        public readonly logId: Buffer      // SHA-256 of SPKI DER
    ) {}

    /**
     * Sign an SCT for the given pre-certificate TBS and issuer key hash,
     * returning the serialized SCT bytes per RFC 6962 Section 3.3.
     */
    signSCT(protoTbsDer: ArrayBuffer, issuerKeyHash: Buffer): Buffer {
        const timestamp = BigInt(Date.now() - SCT_TIMESTAMP_BACKDATE_MS);

        const tbsLen = Buffer.alloc(3);
        tbsLen[0] = (protoTbsDer.byteLength >> 16) & 0xff;
        tbsLen[1] = (protoTbsDer.byteLength >> 8) & 0xff;
        tbsLen[2] = protoTbsDer.byteLength & 0xff;

        const timestampBuf = Buffer.alloc(8);
        timestampBuf.writeBigUInt64BE(timestamp);

        // RFC 6962 Section 3.2: digitally-signed struct for precert SCTs
        const signedData = Buffer.concat([
            Buffer.from([0x00]),           // sct_version = v1
            Buffer.from([0x00]),           // signature_type = certificate_timestamp
            timestampBuf,
            Buffer.from([0x00, 0x01]),     // entry_type = precert_entry
            issuerKeyHash,
            tbsLen,
            Buffer.from(protoTbsDer),
            Buffer.from([0x00, 0x00])      // extensions length = 0
        ]);

        const derSig = nodeCrypto.sign('sha256', signedData, this.privateKey);

        const sigLenBuf = Buffer.alloc(2);
        sigLenBuf.writeUInt16BE(derSig.length);

        return Buffer.concat([
            Buffer.from([0x00]),           // version = v1
            this.logId,                    // log_id (32 bytes)
            timestampBuf,
            Buffer.from([0x00, 0x00]),     // extensions length = 0
            Buffer.from([0x04]),           // hash_algorithm = SHA-256
            Buffer.from([0x03]),           // signature_algorithm = ECDSA
            sigLenBuf,
            derSig
        ]);
    }
}

/**
 * Derive two CT log operators deterministically from a CA certificate.
 * Uses HKDF-SHA256 over the cert's SubjectPublicKeyInfo to derive P-256 private
 * scalars.
 */
export function deriveCTLogOperators(
    caCert: x509.X509Certificate
): [CTLogOperator, CTLogOperator] {
    const caSpki = Buffer.from(caCert.publicKey.rawData);

    const operators = [1, 2].map((i) => {
        const rawScalar = nodeCrypto.hkdfSync(
            'sha256',
            caSpki,
            'httptoolkit-ct',
            'log-operator-' + i,
            32
        );

        const privateKey = buildP256KeyFromScalar(rawScalar);
        const publicKey = nodeCrypto.createPublicKey(
            privateKey.export({ format: 'pem', type: 'pkcs8' })
        ).export({ format: 'der', type: 'spki' });
        const logId = nodeCrypto.createHash('sha256').update(publicKey).digest();

        return new CTLogOperator(privateKey, publicKey, logId);
    });

    return operators as [CTLogOperator, CTLogOperator];
}

/**
 * Embed SCTs into a certificate using a two-pass approach:
 * 1. The input certificate serves as the "proto-certificate" (no SCT extension)
 * 2. Extract its TBS, generate SCTs, add SCT extension, re-sign
 */
export async function embedSCTsAndSign(
    protoCert: x509.X509Certificate,
    ctLogOperators: [CTLogOperator, CTLogOperator],
    issuerKeyHash: Buffer,
    caKey: CryptoKey,
    signingAlgorithm: Parameters<typeof crypto.subtle.sign>[0]
): Promise<ArrayBuffer> {
    const cert = asn1Schema.AsnConvert.parse(protoCert.rawData, asn1X509.Certificate);
    const protoTbsDer = asn1Schema.AsnConvert.serialize(cert.tbsCertificate);

    const scts = ctLogOperators.map(op => op.signSCT(protoTbsDer, issuerKeyHash));

    // Build the SignedCertificateTimestampList extension value.
    // Each SCT is prefixed with its 2-byte length, and the whole list is
    // prefixed with its 2-byte total length. This TLS-encoded list is then
    // wrapped in an ASN.1 OCTET STRING per RFC 6962.
    const serializedSCTs = Buffer.concat(scts.map(sct => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(sct.length);
        return Buffer.concat([len, sct]);
    }));
    const sctListLen = Buffer.alloc(2);
    sctListLen.writeUInt16BE(serializedSCTs.length);
    const sctList = Buffer.concat([sctListLen, serializedSCTs]);

    const innerOctetString = asn1Schema.AsnConvert.serialize(
        new asn1Schema.OctetString(sctList)
    );

    if (!cert.tbsCertificate.extensions) {
        cert.tbsCertificate.extensions = new asn1X509.Extensions();
    }
    cert.tbsCertificate.extensions.push(new asn1X509.Extension({
        extnID: SCT_EXTENSION_OID,
        critical: false,
        extnValue: new asn1Schema.OctetString(innerOctetString)
    }));

    const finalTbsDer = asn1Schema.AsnConvert.serialize(cert.tbsCertificate);
    const rawSignature = await crypto.subtle.sign(signingAlgorithm, caKey, finalTbsDer);

    // WebCrypto emits ECDSA signatures as raw r||s, but X.509 requires the DER
    // ECDSA-Sig-Value encoding. RSA signatures are already in the right form.
    cert.signatureValue = caKey.algorithm.name === 'ECDSA'
        ? toArrayBuffer(ecdsaRawSignatureToDer(rawSignature))
        : rawSignature;

    return asn1Schema.AsnConvert.serialize(cert);
}

// Copy a view's bytes into a standalone ArrayBuffer (X.509 signatureValue is typed
// as ArrayBuffer, not a typed-array view).
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(view.byteLength);
    new Uint8Array(buffer).set(view);
    return buffer;
}

/**
 * Convert a WebCrypto ECDSA signature (raw IEEE-P1363 r||s) into the DER
 * ECDSA-Sig-Value (SEQUENCE { INTEGER r, INTEGER s }) X.509 expects.
 */
function ecdsaRawSignatureToDer(rawSignature: ArrayBuffer): Buffer {
    const raw = Buffer.from(rawSignature);
    const half = raw.length / 2;
    const body = Buffer.concat([
        derInteger(raw.subarray(0, half)),
        derInteger(raw.subarray(half))
    ]);
    return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

function derInteger(value: Buffer): Buffer {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    let content = value.subarray(start);
    if (content[0] & 0x80) content = Buffer.concat([Buffer.from([0x00]), content]);
    return Buffer.concat([Buffer.from([0x02]), derLength(content.length), content]);
}

function derLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    if (length < 0x100) return Buffer.from([0x81, length]);
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

/**
 * Build a Node KeyObject for a P-256 private key from a raw 32-byte scalar.
 * Substitutes the scalar into a fixed PKCS#8 DER template and lets OpenSSL
 * derive the public point.
 */
function buildP256KeyFromScalar(rawScalar: ArrayBuffer): nodeCrypto.KeyObject {
    let scalar = BigInt('0x' + Buffer.from(rawScalar).toString('hex'));
    if (scalar >= P256_ORDER) scalar -= P256_ORDER;
    if (scalar === 0n) scalar = 1n;

    const scalarBytes = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex');
    const pkcs8Der = Buffer.concat([EC_PKCS8_PREFIX, scalarBytes]);

    return nodeCrypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
}

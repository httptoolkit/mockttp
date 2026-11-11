import { expect } from "./test-utils";
import { getCauseFromError } from "../src/util/tls-error-cause";

// Errors as Node reports a client's TLS alert during the handshake, copied from real runs.
const tlsError = (message: string, code: string) =>
    Object.assign(new Error(message), { code });

const openSsl = (alert: number, reason: string, code: string) => tlsError(
    `0013060002000000:error:0A000${(1000 + alert).toString(16)}:SSL routines:ssl3_read_bytes:${reason}:ssl/record/rec_layer_s3.c:910:SSL alert number ${alert}\n`,
    code
);

// BoringSSL, as used by Electron, names the alert only in upper case:
const boringSsl = (alert: number, name: string) => tlsError(
    `1340030782528:error:10000${(1000 + alert).toString(16)}:SSL routines:OPENSSL_internal:${name}:../../third_party/boringssl/src/ssl/tls_record.cc:491:SSL alert number ${alert}\n`,
    `ERR_SSL_${name}`
);

// Mockttp logs each unknown cause: not needed here.
const quietly = <T>(fn: () => T): T => {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
};

describe("TLS error causes", () => {
    it("should spot certificate rejections reported by OpenSSL", () => {
        expect(getCauseFromError(
            openSsl(46, 'tls alert certificate unknown', 'ERR_SSL_TLS_ALERT_CERTIFICATE_UNKNOWN')
        )).to.equal('cert-rejected');
        expect(getCauseFromError(
            openSsl(46, 'ssl/tls alert certificate unknown', 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN')
        )).to.equal('cert-rejected');
        expect(getCauseFromError(
            openSsl(48, 'tlsv1 alert unknown ca', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA')
        )).to.equal('cert-rejected');
        expect(getCauseFromError(
            openSsl(42, 'tls alert bad certificate', 'ERR_SSL_TLS_ALERT_BAD_CERTIFICATE')
        )).to.equal('cert-rejected');
    });

    it("should spot certificate rejections reported by BoringSSL", () => {
        for (const [alert, name] of [
            [42, 'SSLV3_ALERT_BAD_CERTIFICATE'],
            [44, 'SSLV3_ALERT_CERTIFICATE_REVOKED'],
            [45, 'SSLV3_ALERT_CERTIFICATE_EXPIRED'],
            [46, 'SSLV3_ALERT_CERTIFICATE_UNKNOWN'], // As sent by Chrome
            [48, 'TLSV1_ALERT_UNKNOWN_CA'],
            [116, 'TLSV1_ALERT_CERTIFICATE_REQUIRED']
        ] as const) {
            expect(getCauseFromError(boringSsl(alert, name))).to.equal('cert-rejected', name);
        }
    });

    it("should not treat other alerts as certificate rejections, from either", () => quietly(() => {
        expect(getCauseFromError(
            openSsl(40, 'tls alert handshake failure', 'ERR_SSL_TLS_ALERT_HANDSHAKE_FAILURE')
        )).to.equal('unknown');
        expect(getCauseFromError(
            openSsl(43, 'tls alert unsupported certificate', 'ERR_SSL_TLS_ALERT_UNSUPPORTED_CERTIFICATE')
        )).to.equal('unknown');
        expect(getCauseFromError(boringSsl(40, 'SSLV3_ALERT_HANDSHAKE_FAILURE'))).to.equal('unknown');
        expect(getCauseFromError(boringSsl(43, 'SSLV3_ALERT_UNSUPPORTED_CERTIFICATE'))).to.equal('unknown');
    }));
});

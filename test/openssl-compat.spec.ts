import { expect } from 'chai';
import * as tls from 'tls';

import { areFFDHECurvesSupported, isSecLevelSupported } from '../src/util/openssl-compat';

describe('areFFDHECurvesSupported', () => {
    it('True only for 3+ versions', () => {
        expect(areFFDHECurvesSupported('1.0.0')).to.be.false;
        expect(areFFDHECurvesSupported('3.0.0')).to.be.true;
        expect(areFFDHECurvesSupported('4.2.1')).to.be.true;
    });

    it('Copes with older OpenSSL versions format', () => {
        expect(areFFDHECurvesSupported('1.0.1a')).to.be.false;
        expect(areFFDHECurvesSupported('1.1.1t')).to.be.false;
    });

    it('Assumes false for weird versions', () => {
        // Just in case
        expect(areFFDHECurvesSupported('-1.0.0')).to.be.false;
    });

    it('Assumes false when version is uknown', () => {
        expect(areFFDHECurvesSupported(undefined)).to.be.false;
    });
});

describe('isSecLevelSupported', () => {
    it('Matches whether the TLS backend actually accepts the directive', () => {
        // Detected rather than hardcoded, since this suite runs on runtimes with
        // different TLS backends. The point is that the helper agrees with reality.
        let accepted: boolean;
        try {
            tls.createSecureContext({ ciphers: 'AES128-SHA:@SECLEVEL=0' });
            accepted = true;
        } catch (e) {
            accepted = false;
        }

        expect(isSecLevelSupported()).to.equal(accepted);
    });

    it('Is stable across calls', () => {
        expect(isSecLevelSupported()).to.equal(isSecLevelSupported());
    });
});

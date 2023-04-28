import { expect } from 'chai';
import { areFFDHECurvesSupported } from '../src/util/openssl-compat';

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

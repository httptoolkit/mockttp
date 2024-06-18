import { normalizeUrl } from '../src/util/url';

import { expect } from "./test-utils";

describe("URL normalization for matching", () => {
    it("should do nothing to fully specified URLs", () => {
        expect(
            normalizeUrl('https://example.com/abc')
        ).to.equal('https://example.com/abc');
    });

    it("should normalize away default ports", () => {
        expect(
            normalizeUrl('https://example.com:443/abc')
        ).to.equal('https://example.com/abc');
    });

    it("should lowercase the authority & protocol", () => {
        expect(
            normalizeUrl('HTTPS://EXAMPLE.COM/PATH')
        ).to.equal('https://example.com/PATH');
    });

    it("should add trailing slashes for empty paths", () => {
        expect(
            normalizeUrl('https://example.com')
        ).to.equal('https://example.com/');
    });

    it("should add trailing slashes for protocol-less empty paths", () => {
        expect(
            normalizeUrl('example.com')
        ).to.equal('example.com/');
    });

    it("should remove all query parameters", () => {
        expect(
            normalizeUrl('https://example.com/path?a=b')
        ).to.equal('https://example.com/path');
    });

    it("should remove empty query strings", () => {
        expect(
            normalizeUrl('https://example.com/a?')
        ).to.equal('https://example.com/a');
    });

    it("should remove hash fragments", () => {
        expect(
            normalizeUrl('https://example.com/path#abc')
        ).to.equal('https://example.com/path');
    });

    it("should not decode encoded chars", () => {
        expect(
            // ' *$/' - only $ & / officially have a difference between their decoded/encoded versions
            normalizeUrl('https://example.com/path%20%2A%24%2F')
        ).to.equal('https://example.com/path%20%2A%24%2F');
    });

    it("should encode must-be-encoded chars", () => {
        expect(
            // ' *$/' - only $ & / officially have a difference between their decoded/encoded versions
            normalizeUrl('https://example.com/path more-path/')
        ).to.equal('https://example.com/path%20more-path/');
    });

    it("should encode IRI unicode chars", () => {
        expect(
            normalizeUrl('https://example.com/δ%24')
        ).to.equal('https://example.com/%CE%B4%24');
    });

    it("should uppercase percent-encoded hex chars", () => {
        expect(
            // $/ - only / needs encoding, but encoded $ is semantically
            // diferent from decoded, so we do want to preserve it.
            normalizeUrl('http://example.com/%2f')
        ).to.equal('http://example.com/%2F');
    });

    it("should not break when given invalid weird encodings", () => {
        expect(
            // $/ - only / needs encoding, but encoded $ is semantically
            // diferent from decoded, so we do want to preserve it.
            normalizeUrl('https://example.com/%u002A %1 δ ')
        ).to.equal('https://example.com/%U002A%20%1%20%CE%B4');
    });

    it("should convert unicode domains to their punycode equivalent", () => {
        expect(
            normalizeUrl('https://測試.com/')
        ).to.equal('https://xn--g6w251d.com/');
    });

    it("should trim trailing dots from domain names", () => {
        expect(
            normalizeUrl('https://example.com./')
        ).to.equal('https://example.com/');
    });

    it("should normalize relative URLs", () => {
        expect(
            normalizeUrl('/abcδ?d#q')
        ).to.equal('/abc%CE%B4');
    });

    it("should normalize absolute protocol-less URLs", () => {
        expect(
            normalizeUrl('測試.com/abcδ?d#q')
        ).to.equal('xn--g6w251d.com/abc%CE%B4');
    });
});
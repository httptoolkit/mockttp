import {
    buildAbsoluteUrl,
    getDestination,
    getUrlSearch,
    normalizeHost,
    normalizeUrl,
    parseQueryString,
    parseRequestUrl
} from '../src/util/url';

import { expect } from "./test-utils";

describe("URL normalization for matching", () => {
    describe("host normalization", () => {
        it("should bracket IPv6 hosts with non-default HTTP ports", () => {
            expect(
                normalizeHost('http', '[::1]:8000')
            ).to.equal('[::1]:8000');
        });

        it("should bracket IPv6 hosts with non-default HTTPS ports", () => {
            expect(
                normalizeHost('https', '[::1]:8443')
            ).to.equal('[::1]:8443');
        });

        it("should bracket IPv6 hosts when normalizing away the default port", () => {
            expect(
                normalizeHost('http', '[::1]:80')
            ).to.equal('[::1]');

            expect(
                normalizeHost('https', '[::1]:443')
            ).to.equal('[::1]');
        });

        it("should preserve existing formatting for IPv4 and domain hosts", () => {
            expect(
                normalizeHost('http', '127.0.0.1:8000')
            ).to.equal('127.0.0.1:8000');

            expect(
                normalizeHost('https', 'example.com:443')
            ).to.equal('example.com');
        });
    });

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

    it("should resolve dot segments", () => {
        expect(
            normalizeUrl('https://example.com/a/../b/./c/%2e%2E/d')
        ).to.equal('https://example.com/b/d');

        expect(
            normalizeUrl('/a/../b')
        ).to.equal('/b');
    });

    it("should convert backslashes to slashes", () => {
        expect(
            normalizeUrl('https://example.com/a\\b')
        ).to.equal('https://example.com/a/b');
    });

    it("should consistently encode chars that are ambiguously encoded", () => {
        expect(
            normalizeUrl("https://example.com/|^'{}")
        ).to.equal(normalizeUrl("https://example.com/%7c%5E%27%7B%7D"));
    });

    it("should treat relative URLs starting with a double slash as paths", () => {
        expect(
            normalizeUrl('//a/b')
        ).to.equal('//a/b');
    });
});

describe("Destination parsing", () => {
    it("should parse hosts with and without ports", () => {
        expect(getDestination('http', 'example.com')).to.deep.equal({ hostname: 'example.com', port: 80 });
        expect(getDestination('https', 'example.com')).to.deep.equal({ hostname: 'example.com', port: 443 });
        expect(getDestination('http', 'example.com:8080')).to.deep.equal({ hostname: 'example.com', port: 8080 });
        expect(getDestination('http', '[::1]:8080')).to.deep.equal({ hostname: '::1', port: 8080 });
    });
});

describe("Request URL handling", () => {
    const rawPath = '/a/../b/./%2e%2e/c\\d|e{f}?g=../h#i';

    it("should parse absolute URLs without modifying the path or query", () => {
        expect(
            parseRequestUrl(`HTTPS://EXAMPLE.com:443${rawPath}`)
        ).to.deep.equal({
            protocol: 'https:',
            host: 'example.com:443',
            hostname: 'example.com',
            port: '443',
            path: rawPath,
            pathname: '/a/../b/./%2e%2e/c\\d|e{f}',
            search: '?g=../h#i'
        });
    });

    it("should parse IPv6 URLs with unbracketed hostnames", () => {
        const parsed = parseRequestUrl('http://[::1]:8080/a');
        expect(parsed.host).to.equal('[::1]:8080');
        expect(parsed.hostname).to.equal('::1');
        expect(parsed.port).to.equal('8080');
    });

    it("should only include ports that were explicitly specified", () => {
        expect(parseRequestUrl('http://example.com/').host).to.equal('example.com');
        expect(parseRequestUrl('http://example.com/').port).to.equal('');
        expect(parseRequestUrl('http://example.com:80/').host).to.equal('example.com:80');
        expect(parseRequestUrl('http://[::1]:80/').host).to.equal('[::1]:80');
    });

    it("should parse URLs with no path", () => {
        expect(parseRequestUrl('http://example.com').path).to.equal('/');
        expect(parseRequestUrl('http://example.com?a=b').path).to.equal('/?a=b');
    });

    it("should preserve empty queries", () => {
        expect(parseRequestUrl('http://example.com/?').search).to.equal('?');
    });

    it("should encode only the path characters that cannot be sent", () => {
        expect(
            parseRequestUrl('http://example.com/a b\t測é|?c d').path
        ).to.equal('/a%20b%09%E6%B8%ACé|?c%20d');
    });

    it("should never allow line breaks or control characters in paths", () => {
        expect(
            parseRequestUrl('http://example.com/a\r\nInjected: header\u0000?b\r\nc').path
        ).to.equal('/a%0D%0AInjected:%20header%00?b%0D%0Ac');
    });

    it("should treat backslashes as the end of the authority", () => {
        const parsed = parseRequestUrl('http://example.com\\@other.example/x');
        expect(parsed.hostname).to.equal('example.com');
        expect(parsed.path).to.equal('/\\@other.example/x');
    });

    it("should build absolute URLs with unrecognized protocols", () => {
        expect(
            buildAbsoluteUrl('foo', 'example.com:123', rawPath)
        ).to.equal(`foo://example.com:123${rawPath}`);
    });

    it("should refuse to build absolute URLs from invalid paths", () => {
        expect(
            () => buildAbsoluteUrl('http', 'example.com:8000', '*')
        ).to.throw();
    });

    it("should parse query keys that match object prototype properties", () => {
        const query = parseQueryString('?constructor=x&__proto__=y');
        expect(query['constructor']).to.equal('x');
        expect(query['__proto__']).to.equal('y');
    });

    it("should build absolute URLs without modifying the path or query", () => {
        expect(
            buildAbsoluteUrl('https:', 'EXAMPLE.com:443', rawPath)
        ).to.equal(`https://example.com${rawPath}`);

        expect(
            buildAbsoluteUrl('http', '[::1]:8080', rawPath)
        ).to.equal(`http://[::1]:8080${rawPath}`);
    });

    it("should get URL queries, ignoring fragments", () => {
        expect(getUrlSearch('http://example.com/a?b=c#d')).to.equal('?b=c');
        expect(getUrlSearch('/a#b?c')).to.equal('');
        expect(getUrlSearch('/a')).to.equal('');
    });

    it("should parse query strings, collecting repeated keys", () => {
        expect(
            parseQueryString('?a=1&b=x+y&a=2&c&a=%20')
        ).to.deep.equal({ a: ['1', '2', ' '], b: 'x y', c: '' });
    });
});
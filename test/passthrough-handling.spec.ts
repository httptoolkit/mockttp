import * as net from 'net';

import { expect, nodeOnly } from './test-utils';

import {
    applyDestinationTransforms,
    buildOverriddenBody,
    getEffectiveHostname,
    getUpstreamTlsOptions
} from '../src/rules/passthrough-handling';

const applyHostTransform = (
    transform: Parameters<typeof applyDestinationTransforms>[0],
    hostname = 'Original.Example',
    port: string | null = '443'
) => applyDestinationTransforms(transform, {
    isH2Downstream: false,
    rawHeaders: [['Host', port ? `${hostname}:${port}` : hostname]],
    protocol: 'https:',
    hostname,
    port,
    pathname: '/',
    query: ''
});

describe('Passthrough destination transforms', () => {
    nodeOnly(() => {
        it('normalizes a bracketed IPv6 authority to a bare effective hostname', () => {
            expect(getEffectiveHostname(
                '::1',
                new net.Socket(),
                [['Host', '[::1]:8080']]
            )).to.equal('::1');
        });
    });

    it('preserves replacement hostname casing', () => {
        const result = applyHostTransform({
            replaceHost: { targetHost: 'MyVhost.Example.COM:8080' }
        });

        expect(result.hostname).to.equal('MyVhost.Example.COM');
        expect(result.port).to.equal('8080');
        expect(result.rawHeaders).to.deep.equal([
            ['Host', 'MyVhost.Example.COM:8080']
        ]);
    });

    it('formats bracketed IPv6 replacements exactly once', () => {
        const result = applyHostTransform({
            replaceHost: { targetHost: '[::1]:8080' }
        });

        expect(result.hostname).to.equal('::1');
        expect(result.port).to.equal('8080');
        expect(result.reqUrl).to.equal('https://[::1]:8080/');
        expect(result.rawHeaders).to.deep.equal([['Host', '[::1]:8080']]);
    });

    it('accepts bare IPv6 replacements without treating the final group as a port', () => {
        const result = applyHostTransform({
            replaceHost: { targetHost: '::1' }
        });

        expect(result.hostname).to.equal('::1');
        expect(result.port).to.equal(null);
        expect(result.reqUrl).to.equal('https://[::1]/');
        expect(result.rawHeaders).to.deep.equal([['Host', '[::1]']]);
    });

    it('parses hex-only replacement hostnames with their port', () => {
        const result = applyHostTransform({
            replaceHost: { targetHost: 'db:5432' }
        });

        expect(result.hostname).to.equal('db');
        expect(result.port).to.equal('5432');
        expect(result.reqUrl).to.equal('https://db:5432/');
    });

    it('matches IPv6 hosts in bracketed authority form', () => {
        const result = applyHostTransform({
            matchReplaceHost: {
                replacements: [[/^\[::1\]:443$/, '[::2]:8443']]
            }
        }, '::1', '443');

        expect(result.hostname).to.equal('::2');
        expect(result.port).to.equal('8443');
        expect(result.reqUrl).to.equal('https://[::2]:8443/');
    });

    it('leaves IPv6 hosts that no replacement matches unchanged', () => {
        const result = applyHostTransform({
            matchReplaceHost: {
                replacements: [[/example\.com/, 'other.example']]
            }
        }, '::1', '8443');

        expect(result.hostname).to.equal('::1');
        expect(result.port).to.equal('8443');
        expect(result.reqUrl).to.equal('https://[::1]:8443/');
    });

    it('accepts bare IPv6 addresses as replacement results', () => {
        const result = applyHostTransform({
            matchReplaceHost: {
                replacements: [[/^\[::1\]:443$/, '::2']]
            }
        }, '::1', '443');

        expect(result.hostname).to.equal('::2');
        expect(result.port).to.equal(null);
        expect(result.reqUrl).to.equal('https://[::2]/');
    });

    it('preserves malformed client hosts through matchReplaceHost', () => {
        const result = applyHostTransform({
            matchReplaceHost: {
                replacements: [[/example\.com/, 'other.example']]
            }
        }, 'user@example.com', '8080');

        expect(result.hostname).to.equal('user@other.example');
        expect(result.port).to.equal('8080');
    });
});

describe('Passthrough upstream TLS configuration', () => {
    nodeOnly(() => {
        const tlsOptionsFor = (
            hostname: string,
            port: number,
            config: Partial<Parameters<typeof getUpstreamTlsOptions>[0]>
        ) => getUpstreamTlsOptions({
            hostname,
            port,
            ignoreHostHttpsErrors: [],
            clientCertificateHostMap: {},
            trustedCAs: undefined,
            ...config
        });

        it('matches IPv6 hosts in ignoreHostHttpsErrors with or without brackets', () => {
            for (const entry of ['::1', '[::1]', '[::1]:8443']) {
                expect(tlsOptionsFor('::1', 8443, { ignoreHostHttpsErrors: [entry] }).rejectUnauthorized)
                    .to.equal(false, entry);
            }
        });

        it('does not match an unbracketed IPv6 host & port, which is a different address', () => {
            expect(tlsOptionsFor('::1', 8443, { ignoreHostHttpsErrors: ['::1:8443'] }).rejectUnauthorized)
                .to.equal(true);
        });

        it('prefers a host & port client certificate over a host-only one', () => {
            const hostCert = { pfx: Buffer.from('host') };
            const hostAndPortCert = { pfx: Buffer.from('host-and-port') };

            expect(tlsOptionsFor('::1', 8443, {
                clientCertificateHostMap: { '::1': hostCert, '[::1]:8443': hostAndPortCert }
            }).pfx).to.equal(hostAndPortCert.pfx);
            expect(tlsOptionsFor('::1', 8443, {
                clientCertificateHostMap: { '[::1]': hostCert }
            }).pfx).to.equal(hostCert.pfx);
        });
    });
});

describe("Passthrough handling", () => {

    describe("buildOverriddenBody", () => {

        [
            ['false', false],
            ['0', 0],
            ['an empty string', ''],
            ['null', null],
            ['true', true],
            ['an object', { a: 1 }]
        ].forEach(([name, json]) => {
            it(`uses ${name} as a JSON body override`, async () => {
                const headers: { [key: string]: any } = {};
                const body = await buildOverriddenBody({ json } as any, headers);

                expect(body?.toString()).to.equal(JSON.stringify(json));
                expect(headers['content-type']).to.equal('application/json');
            });
        });

        it("returns no override if no body or json is provided", async () => {
            const headers: { [key: string]: any } = {};
            const body = await buildOverriddenBody({}, headers);

            expect(body).to.equal(undefined);
            expect(headers['content-type']).to.equal(undefined);
        });

    });

});

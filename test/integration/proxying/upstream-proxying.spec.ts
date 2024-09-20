import _ = require("lodash");
import * as fs from 'fs/promises';
import request = require("request-promise-native");
import url = require('url');

import { getLocal, Mockttp, MockedEndpoint, getAdminServer, getRemote } from "../../..";
import {
    expect,
    nodeOnly
} from "../../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp configured to proxy traffic upstream", function () {

        let server: Mockttp;
        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        describe("to an HTTP proxy", () => {

            const intermediateProxy = getLocal();
            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal();
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough(); // Totally neutral proxy

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            it("should forward traffic through the remote proxy", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should support authenticating to the remote proxy", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                            .replace('://', '://username:password@')
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);

                // N.B: we don't actually check that the auth params are used here, only that the request with
                // them in the URL sends OK. We can't, unfortunately, since they only exist in the CONNECT
                // and that's always unwrapped and never exposed. Visible in Wireshark though.
            });

            it("should skip the proxy if the target is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if the target is in the no-proxy list with a matching port", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: [`localhost:${remoteServer.port}`]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if the target's implicit port is in the no-proxy list", async () => {
                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com:80']
                    }
                });

                await request.get('http://example.com/').catch(() => {});

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if a suffix of the target is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost']
                    }
                });

                const response = await request.get(
                    `http://test-subdomain.localhost:${remoteServer.port}/test-url`
                );

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should not skip the proxy if an unrelated URL is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should not skip the proxy if the target's port is not in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost:1234']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should not skip the proxy if the target's implicit port is not in the no-proxy list", async () => {
                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com:443']
                    }
                });

                await request.get('http://example.com/').catch(() => {});

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should forward traffic through the remote proxy specified by a callback", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: ({ hostname }) => {
                        expect(hostname).to.equal('localhost');
                        return { proxyUrl: intermediateProxy.url }
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });
        });

        describe("to an HTTPS proxy", () => {

            const intermediateProxy = getLocal({
                https: {
                    keyPath: './test/fixtures/untrusted-ca.key',
                    certPath: './test/fixtures/untrusted-ca.pem'
                }
            });
            // HTTPS proxy - note that the remote server is plain HTTP.

            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal();
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough(); // Totally neutral proxy

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            it("should not trust unknown proxy CAs by default", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                    }
                });

                const result = await request.get(remoteServer.urlFor("/test-url")).catch(e => e);

                expect(result).to.be.instanceOf(Error);
                expect(result.message).to.match(/self(-| )signed certificate/); // Dash varies by Node version
            });

            it("should trust the remote proxy's CA if explicitly specified by content", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        trustedCAs: [
                            { cert: await fs.readFile('./test/fixtures/untrusted-ca.pem') }
                        ]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should trust the remote proxy's CA if explicitly specified by file path", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        trustedCAs: [
                            { certPath: './test/fixtures/untrusted-ca.pem' }
                        ]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should trust the remote proxy's CA if explicitly specified as additional", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        additionalTrustedCAs: [
                            { cert: (await fs.readFile('./test/fixtures/untrusted-ca.pem')).toString() }
                        ]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });
        });

        describe("with a remote client", () => {

            const adminServer = getAdminServer();

            before(() => adminServer.start());
            after(() => adminServer.stop());

            beforeEach(async () => {
                server = getRemote();
                await server.start();

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            describe("to an HTTPS proxy", () => {

                const intermediateProxy = getLocal({
                    https: {
                        keyPath: './test/fixtures/untrusted-ca.key',
                        certPath: './test/fixtures/untrusted-ca.pem'
                    }
                });
                // HTTPS proxy - note that the remote server is plain HTTP.

                let proxyEndpoint: MockedEndpoint;

                beforeEach(async () => {
                    await intermediateProxy.start();
                    proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough(); // Totally neutral proxy
                });

                afterEach(() => intermediateProxy.stop());

                it("should not trust unknown proxy CAs by default", async () => {
                    // Remote server sends fixed response on this one URL:
                    await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                    // Mockttp forwards requests via our intermediate proxy
                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: intermediateProxy.url
                        }
                    });

                    const result = await request.get(remoteServer.urlFor("/test-url")).catch(e => e);

                    expect(result).to.be.instanceOf(Error);
                    expect(result.message).to.match(/self(-| )signed certificate/); // Dash varies by Node version
                });

                it("should trust the remote proxy's CA if explicitly specified", async () => {
                    // Remote server sends fixed response on this one URL:
                    await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                    // Mockttp forwards requests via our intermediate proxy
                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: intermediateProxy.url,
                            trustedCAs: [
                                { cert: await fs.readFile('./test/fixtures/untrusted-ca.pem') }
                            ]
                        }
                    });

                    const response = await request.get(remoteServer.urlFor("/test-url"));

                    // We get a successful response
                    expect(response).to.equal("Remote server says hi!");
                    // And it went via the intermediate proxy
                    expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
                });

                it("should trust the remote proxy's CA if explicitly specified as additional", async () => {
                    // Remote server sends fixed response on this one URL:
                    await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                    // Mockttp forwards requests via our intermediate proxy
                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: intermediateProxy.url,
                            additionalTrustedCAs: [
                                { cert: (await fs.readFile('./test/fixtures/untrusted-ca.pem')).toString() }
                            ]
                        }
                    });

                    const response = await request.get(remoteServer.urlFor("/test-url"));

                    // We get a successful response
                    expect(response).to.equal("Remote server says hi!");
                    // And it went via the intermediate proxy
                    expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
                });

            });

        });

        describe("with a PAC file", () => {
            const https = {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            };
    
            const intermediateProxy = getLocal({ https });
    
            beforeEach(async () => {
                server = getLocal({ https });
                await server.start();

                await intermediateProxy.start();
    
                process.env = _.merge({}, process.env, server.proxyEnv);
            });
    
            afterEach(async () => {
                await intermediateProxy.stop();
            });
    
            it("should forward traffic to intermediateProxy using PAC file", async () => {
                const pacFile = `function FindProxyForURL(url, host) { return "PROXY ${url.parse(intermediateProxy.url).host}"; }`;
                await remoteServer.forGet('/proxy-all').thenReply(200, pacFile);

                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    proxyConfig: {
                      proxyUrl: `pac+${remoteServer.url}/proxy-all`
                    }
                });
    
                await intermediateProxy.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    beforeRequest: (req) => {
                        expect(req.url).to.equal('https://example.com/');
                    }
                });
    
                // make request
                await request.get('https://example.com/');
            });
    
            it("should bypass intermediateProxy using PAC file", async () => {
                const pacFile = `function FindProxyForURL(url, host) { if (host.endsWith(".org")) return "DIRECT"; return "PROXY ${url.parse(intermediateProxy.url).host}";  }`;
                await remoteServer.forGet('/proxy-bypass').thenReply(200, pacFile);

                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    proxyConfig: {
                      proxyUrl: `pac+${remoteServer.url}/proxy-bypass`
                    }
                });
    
                await intermediateProxy.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    beforeRequest: (req) => {
                        expect(req.url).to.not.equal('https://example.org/');
                    }
                });
    
                // make a request that hits the proxy based on PAC file
                await request.get('https://example.com/');

                // make a request that bypasses proxy based on PAC file
                await request.get('https://example.org/');
            });
    
            it("should fallback to intermediateProxy using PAC file", async () => {
                const pacFile = `function FindProxyForURL(url, host) { return "PROXY invalid-proxy:8080; PROXY ${url.parse(intermediateProxy.url).host};";  }`;
                await remoteServer.forGet('/proxy-fallback').thenReply(200, pacFile);

                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    proxyConfig: {
                      proxyUrl: `pac+${remoteServer.url}/proxy-fallback`
                    }
                });
    
                await intermediateProxy.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: true,
                    beforeRequest: (req) => {
                        expect(req.url).to.equal('https://example.com/');
                    }
                });
    
                // make a request
                await request.get('https://example.com/');
            });
        });

    });

});
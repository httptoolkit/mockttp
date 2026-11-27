import _ from 'lodash';
import * as fs from 'fs/promises';
import request from 'request-promise-native';
import * as url from 'url';

import {
    getLocal,
    Mockttp,
    MockedEndpoint,
    RuleEvent,
    getAdminServer,
    getRemote,
    generateCACertificate
} from "../../..";
import {
    expect,
    nodeOnly,
    pollUntil,
    TEST_ADMIN_SERVER_PORT,
    TEST_ADMIN_SERVER_URL
} from "../../test-utils";
import { startTestProxy, TestProxy } from "../../fixtures/test-connect-proxy";

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

            it("should send the target hostname to the proxy, rather than resolving it locally", async () => {
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                const proxy = await startTestProxy();
                try {
                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: { proxyUrl: proxy.url }
                    });

                    expect(await request.get(remoteServer.urlFor("/test-url")))
                        .to.equal("Remote server says hi!");

                    // 'localhost' must reach the proxy as a name, so that remote resolution
                    // stays meaningful:
                    expect(proxy.connectRequests.map(({ target }) => target))
                        .to.deep.equal([`localhost:${remoteServer.port}`]);
                } finally {
                    await proxy.stop();
                }
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
                        noProxy: ['example.testserver.host:80']
                    }
                });

                await request.get('http://example.testserver.host/').catch(() => {});

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
                        noProxy: ['example.testserver.host']
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
                        noProxy: ['example.testserver.host:443']
                    }
                });

                await request.get('http://example.com/').catch(() => {});

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should route different hostnames to different proxies", async () => {
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                const otherProxy = getLocal();
                await otherProxy.start();
                const otherProxyEndpoint = await otherProxy.forAnyRequest().thenPassThrough();

                try {
                    // The callback only receives a hostname, so we address the same server
                    // by two different names, to check each is routed independently:
                    const seenHostnames: string[] = [];
                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: ({ hostname }) => {
                            seenHostnames.push(hostname);
                            return {
                                proxyUrl: hostname === 'localhost'
                                    ? intermediateProxy.url
                                    : otherProxy.url
                            };
                        }
                    });

                    expect(await request.get(`http://localhost:${remoteServer.port}/test-url`))
                        .to.equal("Remote server says hi!");
                    expect(await request.get(`http://127.0.0.1:${remoteServer.port}/test-url`))
                        .to.equal("Remote server says hi!");

                    expect((await proxyEndpoint.getSeenRequests()).map((r) => r.url))
                        .to.deep.equal([`http://localhost:${remoteServer.port}/test-url`]);
                    expect((await otherProxyEndpoint.getSeenRequests()).map((r) => r.url))
                        .to.deep.equal([`http://127.0.0.1:${remoteServer.port}/test-url`]);
                    expect(_.uniq(seenHostnames)).to.deep.equal(['localhost', '127.0.0.1']);
                } finally {
                    await otherProxy.stop();
                }
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

        describe("to a SOCKS proxy", () => {

            // Mockttp can act as a SOCKS server itself, so we use a second instance as the
            // upstream SOCKS proxy, which then passes traffic through to the remote server.
            const intermediateProxy = getLocal({
                socks: true,
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal();
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough();

                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            [
                // SOCKS4 has no hostname support, so it resolves locally and can only send
                // an IPv4 address upstream. The rest can all take a hostname directly.
                { scheme: 'socks4', targetHost: '127.0.0.1' },
                { scheme: 'socks', targetHost: 'localhost' },
                { scheme: 'socks4a', targetHost: 'localhost' },
                { scheme: 'socks5', targetHost: 'localhost' },
                { scheme: 'socks5h', targetHost: 'localhost' }
            ].forEach(({ scheme, targetHost }) => {
                it(`should forward traffic through a ${scheme}: proxy`, async () => {
                    await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                    await server.forAnyRequest().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: `${scheme}://localhost:${intermediateProxy.port}`
                        }
                    });

                    const response = await request.get(
                        `http://${targetHost}:${remoteServer.port}/test-url`
                    );

                    expect(response).to.equal("Remote server says hi!");
                    expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
                });
            });

        });

        describe("authenticating to an upstream proxy", () => {

            // Mockttp consumes & strips the CONNECT's Proxy-Authorization header, so we use
            // a raw proxy here to check the credentials we send actually reach the wire.

            const testCa = {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            };

            let proxy: TestProxy;
            let httpsRemoteServer: Mockttp;
            let remoteEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal({ https: testCa });
                await server.start();

                proxy = await startTestProxy({ requireAuth: 'username:password' });

                httpsRemoteServer = getLocal({ https: testCa });
                await httpsRemoteServer.start();
                remoteEndpoint = await httpsRemoteServer.forGet('/test-url')
                    .thenReply(200, "Remote HTTPS server says hi!");

                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(async () => {
                await proxy.stop();
                await httpsRemoteServer.stop();
            });

            it("should send proxy credentials in the CONNECT request", async () => {
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: proxy.url.replace('://', '://username:password@')
                    }
                });

                const response = await request.get(httpsRemoteServer.urlFor('/test-url'));
                expect(response).to.equal("Remote HTTPS server says hi!");

                const authHeader = proxy.connectRequests[0].headers
                    .find(([key]) => key.toLowerCase() === 'proxy-authorization');
                expect(authHeader?.[1]).to.equal(
                    `Basic ${Buffer.from('username:password').toString('base64')}`
                );
            });

            // Known gap: https-proxy-agent replays a refused CONNECT to the client as if the
            // target had sent it, so the proxy's 407 challenge reaches the client.
            it.skip("should return a 502 if the proxy rejects the credentials", async () => {
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: proxy.url.replace('://', '://wrong:credentials@')
                    }
                });

                const response = await request.get({
                    url: httpsRemoteServer.urlFor('/test-url'),
                    simple: false,
                    resolveWithFullResponse: true
                });

                // The challenge was for our proxy configuration, not the client's, so it must
                // not be passed on as if the target had sent it:
                expect(response.statusCode).to.equal(502);
                expect(response.headers['proxy-authenticate']).to.equal(undefined);
                expect(proxy.connectRequests.length).to.equal(1);
                expect((await remoteEndpoint.getSeenRequests()).length).to.equal(0);
            });

        });

        describe("tunnelling through a proxy to an untrusted upstream", () => {

            // The intermediate proxy tunnels all TLS through without intercepting it, so
            // the upstream server's own certificate reaches us. That lets us check that
            // upstream trust is required & configured independently of the proxy connection
            // itself. We talk to the proxy in plaintext, so that passing everything through
            // doesn't also capture the inbound connection to the proxy.

            const testCa = {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            };

            let upstreamCa: { key: string, cert: string };
            let intermediateProxy: Mockttp;
            let upstreamServer: Mockttp;
            let tunnelledConnections: number;

            before(async () => {
                upstreamCa = await generateCACertificate();
            });

            beforeEach(async () => {
                server = getLocal({ https: testCa });
                await server.start();

                intermediateProxy = getLocal({
                    https: { ...testCa, tlsPassthrough: [{ hostname: '*' }] }
                });
                await intermediateProxy.start();

                tunnelledConnections = 0;
                await intermediateProxy.on('tls-passthrough-opened', () => {
                    tunnelledConnections += 1;
                });

                upstreamServer = getLocal({ https: upstreamCa });
                await upstreamServer.start();
                await upstreamServer.forGet('/test-url').thenReply(200, "Upstream says hi!");

                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(async () => {
                await intermediateProxy.stop();
                await upstreamServer.stop();
            });

            const proxyConfig = () => ({
                proxyUrl: `http://localhost:${intermediateProxy.port}`
            });

            it("should not trust an unknown upstream CA, even through a tunnel", async () => {
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: proxyConfig()
                });

                const result = await request.get(upstreamServer.urlFor('/test-url'))
                    .catch(e => e);

                expect(result).to.be.instanceOf(Error);
                // The tunnel itself was fine - it's the upstream certificate we reject:
                expect(tunnelledConnections).to.equal(1);
            });

            it("should trust the upstream CA when it is explicitly configured", async () => {
                await server.forAnyRequest().thenPassThrough({
                    additionalTrustedCAs: [{ cert: upstreamCa.cert }],
                    proxyConfig: proxyConfig()
                });

                expect(await request.get(upstreamServer.urlFor('/test-url')))
                    .to.equal("Upstream says hi!");
                expect(tunnelledConnections).to.equal(1);
            });

        });

        describe("when the upstream proxy fails", () => {

            const testCa = {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            };

            let proxy: TestProxy;
            let httpsRemoteServer: Mockttp;
            let remoteEndpoint: MockedEndpoint;

            beforeEach(async () => {
                httpsRemoteServer = getLocal({ https: testCa });
                await httpsRemoteServer.start();
                remoteEndpoint = await httpsRemoteServer.forGet('/test-url')
                    .thenReply(200, "Remote HTTPS server says hi!");
            });

            afterEach(async () => {
                await proxy.stop();
                await httpsRemoteServer.stop();
            });

            const startServer = async (options: { simulateConnectionErrors?: boolean } = {}) => {
                server = getLocal({ https: testCa });
                await server.start();
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: { proxyUrl: proxy.url },
                    ...options
                });
                process.env = _.merge({}, process.env, server.proxyEnv);
            };

            // Known gap: https-proxy-agent replays a refused CONNECT to the client as if the
            // target had sent it, so the proxy's own response reaches the client.
            it.skip("should treat a refused CONNECT as a failure to reach the upstream", async () => {
                proxy = await startTestProxy({ behaviour: 'reject-502' });
                await startServer();

                const ruleEvents: RuleEvent[] = [];
                await server.on('rule-event', (event) => ruleEvents.push(event));

                const response = await request.get({
                    url: httpsRemoteServer.urlFor('/test-url'),
                    simple: false,
                    resolveWithFullResponse: true
                });

                // We never reached the target, so this is our own connection failure, not a
                // response to pass on as if the target had sent it:
                expect(response.statusCode).to.equal(502);
                expect(response.headers['x-test-proxy']).to.equal(undefined);
                expect((await remoteEndpoint.getSeenRequests()).length).to.equal(0);

                const isAbortEvent = ({ eventType }: RuleEvent) => eventType === 'passthrough-abort';
                await pollUntil(() => ruleEvents.some(isAbortEvent));
            });

            it("should return a 502 and report an upstream abort if the proxy drops the connection", async () => {
                proxy = await startTestProxy({ behaviour: 'drop' });
                await startServer();

                const ruleEvents: RuleEvent[] = [];
                await server.on('rule-event', (event) => ruleEvents.push(event));

                const result: Error & { statusCode?: number } = await request
                    .get(httpsRemoteServer.urlFor('/test-url'))
                    .catch(e => e);

                expect(result).to.be.instanceOf(Error);
                expect(result.statusCode).to.equal(502);
                expect((await remoteEndpoint.getSeenRequests()).length).to.equal(0);

                const isAbortEvent = ({ eventType }: RuleEvent) => eventType === 'passthrough-abort';
                await pollUntil(() => ruleEvents.some(isAbortEvent));
                const eventData = ruleEvents.find(isAbortEvent)!.eventData as {
                    downstreamAborted: boolean,
                    tags: string[]
                };
                expect(eventData.downstreamAborted).to.equal(false);
                // Proxy failures are tagged just like upstream server failures,
                // with no way to tell the two apart:
                expect(eventData.tags.some((tag) => tag.startsWith('passthrough-error:')))
                    .to.equal(true);
            });

            it("should reset the downstream connection if simulateConnectionErrors is set", async () => {
                proxy = await startTestProxy({ behaviour: 'drop' });
                await startServer({ simulateConnectionErrors: true });

                const result: Error & { statusCode?: number } = await request
                    .get(httpsRemoteServer.urlFor('/test-url'))
                    .catch(e => e);

                expect(result).to.be.instanceOf(Error);
                // A connection-level failure, rather than a 502 response:
                expect(result.statusCode).to.equal(undefined);
            });

        });

        describe("with a remote client", () => {

            const adminServer = getAdminServer();

            before(() => adminServer.start(TEST_ADMIN_SERVER_PORT));
            after(() => adminServer.stop());

            beforeEach(async () => {
                server = getRemote({ adminServerUrl: TEST_ADMIN_SERVER_URL });
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
                        return {
                            response: {
                                statusCode: 200,
                                body: 'Proxied'
                            }
                        };
                    }
                });

                // make a request that hits the proxy based on PAC file
                expect(await request.get('https://example.com/')).to.equal('Proxied');
            });

            it("should bypass intermediateProxy using PAC file", async () => {
                const pacFile = `function FindProxyForURL(url, host) { if (host.endsWith(".com")) { return "PROXY ${url.parse(intermediateProxy.url).host}"; } else { return "DIRECT"; } }`;
                await remoteServer.forGet('/proxy-bypass').thenReply(200, pacFile);
                await remoteServer.forGet('/remote-response').thenReply(200, 'Remote response');

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
                        return {
                            response: {
                                statusCode: 200,
                                body: 'Proxied'
                            }
                        };
                    }
                });

                // make a request that hits the proxy based on PAC file
                expect(await request.get('https://example.com/')).to.equal('Proxied');

                // make a request that bypasses proxy based on PAC file
                expect(await request.get(remoteServer.urlFor('/remote-response'))).to.equal('Remote response');
            });

            it("should fetch the PAC file itself over HTTPS", async () => {
                const pacServer = getLocal({ https });
                await pacServer.start();

                try {
                    const pacFile = `function FindProxyForURL(url, host) { return "PROXY ${url.parse(intermediateProxy.url).host}"; }`;
                    await pacServer.forGet('/proxy-all').thenReply(200, pacFile);

                    await server.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: true,
                        proxyConfig: {
                            proxyUrl: `pac+${pacServer.url}/proxy-all`
                        }
                    });

                    await intermediateProxy.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: true,
                        beforeRequest: (req) => {
                            expect(req.url).to.equal('https://example.com/');
                            return {
                                response: {
                                    statusCode: 200,
                                    body: 'Proxied'
                                }
                            };
                        }
                    });

                    expect(await request.get('https://example.com/')).to.equal('Proxied');
                } finally {
                    await pacServer.stop();
                }
            });

            it("should fallback to intermediateProxy using PAC file", async () => {
                const pacFile = `function FindProxyForURL(url, host) { return "PROXY invalid-proxy.invalid:8080; PROXY ${url.parse(intermediateProxy.url).host};";  }`;
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
                        return {
                            response: {
                                statusCode: 200,
                                body: 'Proxied'
                            }
                        };
                    }
                });

                // make a request that hits the proxy based on PAC file
                expect(await request.get('https://example.com/')).to.equal('Proxied');
            });
        });

    });

});
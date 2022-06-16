import * as net from 'net';
import * as WebSocket from 'isomorphic-ws';
import * as https from 'https';
import HttpProxyAgent = require('http-proxy-agent');
import HttpsProxyAgent = require('https-proxy-agent');
import * as portfinder from 'portfinder';

import { getLocal, generateCACertificate, MockedEndpoint } from '../..';

import {
    expect,
    nodeOnly,
    browserOnly,
    startDnsServer,
    DestroyableServer,
    destroyable
} from '../test-utils';
import { getCA } from '../../src/util/tls';
import { delay } from '../../src/util/util';

browserOnly(() => {
    describe('Websocket requests', function() {

        let mockServer = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => mockServer.start());
        afterEach(() => mockServer.stop());

        it("can be defined and passed through from the browser", async function () {
            // Forward to WS echo fixture, see websocket-test-server.js
            await mockServer.forAnyWebSocket().thenForwardTo('ws://localhost:8694');

            const ws = new WebSocket(mockServer.url.replace('http', 'ws'));

            ws.addEventListener('open', () => ws.send('test echo'));

            const response = await new Promise((resolve, reject) => {
                ws.addEventListener('message', (evt) => resolve(evt.data.toString()));
                ws.addEventListener('error', (e) => reject(e));
            });
            ws.close(1000);

            expect(response).to.equal('test echo');
        });
        // Browser testing is limited, since we can't configure target WS server
        // behaviour, at least until Mockttp can spawn them for us.
    });
});

nodeOnly(() => {
    describe('Websockets', function() {
        this.timeout(1000);

        let mockServer = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        let wsServer: WebSocket.Server;
        let wsErrors: Error[] = [];

        let wsPort: number;

        beforeEach(async () => {
            await mockServer.start();
            wsErrors = [];

            // Real server that echoes every message
            wsPort = await portfinder.getPortPromise();
            wsServer = new WebSocket.Server({ port: wsPort });

            wsServer.on('connection', (ws, request) => {
                if (request.headers['echo-header']) {
                    ws.send("echo-header: " + request.headers['echo-header']);
                }

                ws.on('message', (message, isBinary) => {
                    ws.send(message, { binary: isBinary });
                    ws.close();
                });

                ws.on('error', (e) => wsErrors.push(e));
            });

            wsServer.on('error', (e) => wsErrors.push(e));
        });

        afterEach(async () => {
            await mockServer.stop();
            if (wsServer) {
                await new Promise((resolve) => wsServer.close(resolve));
                if (wsErrors.length) console.log(wsErrors);
                expect(wsErrors).to.deep.equal([]);
            }
        });

        describe("with default rules", () => {

            it("should reject websockets with 503 by default", async () => {
                const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                const result = await new Promise<'open' | Error>((resolve) => {
                    ws.on('open', () => resolve('open'));
                    ws.on('error', (e) => resolve(e));
                });

                expect(result).to.be.instanceOf(Error);
                expect((result as Error).message).to.equal("Unexpected server response: 503");
                ws.close(1000);
            });

        });

        describe("when passed through", () => {

            it("can be passed through untouched", async () => {
                mockServer.forAnyWebSocket().thenPassThrough();

                const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                ws.on('open', () => ws.send('test echo'));

                const response = await new Promise<Buffer>((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', reject);
                });
                ws.close(1000);

                expect(response.toString()).to.equal('test echo');
            });

            it("forwards the incoming requests's headers", async () => {
                mockServer.forAnyWebSocket().thenPassThrough();

                const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`),
                    headers: {
                        'echo-header': 'a=b'
                    }
                });

                const response = await new Promise<Buffer>((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', reject);
                });
                ws.close(1000);

                expect(response.toString()).to.equal('echo-header: a=b');
            });

            it("can handle & proxy invalid client frames upstream", async () => {
                mockServer.forAnyWebSocket().thenPassThrough();

                const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                await new Promise<void>((resolve) => {
                    ws.on('open', () => {
                        const rawWs = ws as any;

                        // Badly behaved games with the ws internals:
                        const buf = Buffer.allocUnsafe(2);
                        buf.writeUInt16BE(0);
                        const sender = rawWs._sender;
                        sender.sendFrame(sender.constructor.frame(buf, {
                            fin: true,
                            rsv1: false,
                            opcode: 0x08,
                            mask: true,
                            readOnly: false
                        }), () => {
                            rawWs._socket.end();
                            resolve();
                        });
                    });
                });

                // Make sure the error was proxied upstream:
                await delay(50);
                expect(wsErrors.length).to.equal(1);
                expect(wsErrors[0].message).to.include("invalid status code 0");
                wsErrors = []; // Clear this, so the test passes, since it's expected
            });

            it('can be passed through successfully over HTTPS', async () => {
                mockServer.forAnyWebSocket().thenPassThrough();

                const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                    agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                });

                ws.on('open', () => ws.send('test echo'));

                const response = await new Promise<Buffer>((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', reject);
                });
                ws.close(1000);

                expect(response.toString()).to.equal('test echo');
            });

            describe("to an HTTPS WS server", () => {

                let wsHttpsServer: DestroyableServer & https.Server;

                beforeEach(async () => {
                    const ca = await getCA({
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    });
                    const cert = ca.generateCertificate('localhost');
                    wsHttpsServer = destroyable(https.createServer({
                        key: cert.key,
                        cert: cert.cert
                    }));

                    const wssServer = new WebSocket.Server({ server: wsHttpsServer });

                    // Echo every message
                    wssServer.on('connection', (ws) => {
                        ws.on('message', (message, isBinary) => {
                            ws.send(message, { binary: isBinary });
                            ws.close();
                        });
                    });

                    wsPort = await portfinder.getPortPromise();

                    await new Promise<void>((resolve) => wsHttpsServer.listen(wsPort, resolve));
                });

                afterEach(() => wsHttpsServer.destroy());

                it('can be passed through successfully over HTTP', async () => {
                    mockServer.forAnyWebSocket().thenPassThrough();

                    const ws = new WebSocket(`wss://localhost:${wsPort}`, {
                        agent: new HttpsProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    expect(response.toString()).to.equal('test echo');
                });

                it('can be passed through successfully over HTTPS', async () => {
                    mockServer.forAnyWebSocket().thenPassThrough();

                    const ws = new WebSocket(`wss://localhost:${wsPort}`, {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    expect(response.toString()).to.equal('test echo');
                });

            });

            describe("to an untrusted HTTPS WS server", () => {

                let wsHttpsServer: DestroyableServer & https.Server;
                const untrustedCACert = generateCACertificate({ bits: 1024 });

                beforeEach(async () => {
                    const ca = await getCA(await untrustedCACert);
                    const cert = ca.generateCertificate('localhost');
                    wsHttpsServer = destroyable(https.createServer({
                        key: cert.key,
                        cert: cert.cert
                    }));

                    const wssServer = new WebSocket.Server({ server: wsHttpsServer });

                    // Echo every message
                    wssServer.on('connection', (ws) => {
                        ws.on('message', (message, isBinary) => {
                            ws.send(message, { binary: isBinary });
                            ws.close();
                        });
                    });

                    wsPort = await portfinder.getPortPromise();
                    await new Promise<void>((resolve) => wsHttpsServer.listen(wsPort, resolve));
                });

                afterEach(() => wsHttpsServer.destroy());

                it('should kill the request by default', async () => {
                    mockServer.forAnyWebSocket().thenPassThrough();

                    const ws = new WebSocket(`wss://localhost:${wsPort}`, {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const error = await new Promise<Error>((resolve, reject) => {
                        ws.on('message', reject);
                        ws.on('error', resolve);
                    });
                    ws.close(1000);

                    expect(error.message).to.equal('socket hang up');
                });

                it('should allow the request, if the host is configured as trustworthy', async () => {
                    mockServer.forAnyWebSocket().thenPassThrough({
                        ignoreHostHttpsErrors: [`localhost:${wsPort}`]
                    });

                    const ws = new WebSocket(`wss://localhost:${wsPort}`, {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    expect(response.toString()).to.equal('test echo');
                });

                it("should still block the request if the hostname doesn't match", async () => {
                    mockServer.forAnyWebSocket().thenPassThrough({
                        ignoreHostHttpsErrors: [`localhost:${wsPort}`]
                    });

                    const ws = new WebSocket(`wss://testname.localhost:${wsPort}`, { // Different name
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const error = await new Promise<Error>((resolve, reject) => {
                        ws.on('message', reject);
                        ws.on('error', resolve);
                    });
                    ws.close(1000);

                    expect(error.message).to.equal('socket hang up');
                });

                describe("when the websocket server is unavailable", () => {

                    it('should immediately close the socket', async () => {
                        mockServer.forAnyWebSocket().thenPassThrough();

                        const ws = new WebSocket('ws://localhost:1001', { // <- not the correct port
                            agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                        });

                        ws.on('open', () => ws.send('test echo'));

                        const error = await new Promise<Error>((resolve, reject) => {
                            ws.on('message', reject);
                            ws.on('error', resolve);
                        });
                        ws.close(1000);

                        expect(error.message).to.equal('socket hang up');
                    });

                });

                describe("when the websocket server rejects the request", () => {

                    beforeEach(async () => {
                        if (wsServer) wsServer.close();
                        wsServer = new WebSocket.Server({
                            port: 9001,
                            verifyClient: () => false // Reject all clients
                        });
                    });

                    it('should mirror the request rejection', async () => {
                        mockServer.forAnyWebSocket().thenPassThrough();

                        const ws = new WebSocket(`ws://localhost:9001`, {
                            agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                        });

                        ws.on('open', () => ws.send('test echo'));

                        const error = await new Promise<Error>((resolve, reject) => {
                            ws.on('message', reject);
                            ws.on('error', resolve);
                        });
                        ws.close(1000);

                        expect(error.message).to.equal('Unexpected server response: 401');
                    });

                });

            });

            describe("given an upstream proxy", () => {

                const intermediateProxy = getLocal();
                let proxyEndpoint: MockedEndpoint;

                beforeEach(async () => {
                    await intermediateProxy.start();
                    // Totally neutral WS proxy:
                    proxyEndpoint = await intermediateProxy.forAnyWebSocket().thenPassThrough();
                });

                afterEach(() => intermediateProxy.stop());

                it("can be passed through via an upstream proxy", async () => {
                    await mockServer.forAnyWebSocket().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: intermediateProxy.url
                        }
                    });

                    const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    // We get our echoed responses:
                    expect(response.toString()).to.equal('test echo');
                    // And they go via the intermediate proxy
                    expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
                });

                it("can skip the upstream proxy when noProxy is used", async () => {
                    await mockServer.forAnyWebSocket().thenPassThrough({
                        proxyConfig: {
                            proxyUrl: intermediateProxy.url,
                            noProxy: ['localhost']
                        }
                    });

                    const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    // We get our echoed responses:
                    expect(response.toString()).to.equal('test echo');

                    // But it doesn't go via the intermediate proxy:
                    expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
                });

            });

            describe("with a custom DNS server", () => {

                let dnsServer: (DestroyableServer & net.Server) | undefined;
                let fixedDnsResponse: string | undefined = undefined;

                before(async () => {
                    dnsServer = await startDnsServer(() => fixedDnsResponse);
                });

                after(async () => {
                    await dnsServer!.destroy();
                });

                it("can be passed through with custom DNS resolution", async () => {
                    fixedDnsResponse = '127.0.0.1'; // Send all requests to localhost

                    mockServer.forAnyWebSocket().thenPassThrough({
                        lookupOptions: {
                            servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                        }
                    });

                    // Send to an invalid domain - should magically resolve regardless
                    const ws = new WebSocket(`ws://nope.test:${wsPort}`, {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise<Buffer>((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', reject);
                    });
                    ws.close(1000);

                    expect(response.toString()).to.equal('test echo');
                });
            });
        });

        it("can be redirected elsewhere", async () => {
            mockServer.forAnyWebSocket().thenForwardTo(`localhost:${wsPort}`);

            // Ask for 999 (doesn't exist), and the above will forward you
            // invisibly to our real WS server elsewhere instead.
            const ws = new WebSocket('ws://localhost:999', {
                agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
            });

            ws.on('open', () => ws.send('test echo'));

            const response = await new Promise<Buffer>((resolve, reject) => {
                ws.on('message', resolve);
                ws.on('error', reject);
            });
            ws.close(1000);

            expect(response.toString()).to.equal('test echo');
        });

        it("can echo data", async () => {
            mockServer.forAnyWebSocket().thenEcho();

            const ws = new WebSocket(`ws://localhost:${mockServer.port}`);

            ws.on('open', () => ws.send('test message'));

            const response = await new Promise<Buffer>((resolve, reject) => {
                ws.on('message', resolve);
                ws.on('error', reject);
            });
            ws.close(1000);

            expect(response.toString()).to.equal('test message');
        });

        it("can passively listen to data", async () => {
            mockServer.forAnyWebSocket().thenPassivelyListen();

            const ws = new WebSocket(`ws://localhost:${mockServer.port}`);

            ws.on('open', () => ws.send('test message'));

            await new Promise<void>((resolve, reject) => {
                ws.on('message', reject);
                ws.on('error', reject);

                // All OK as long as we get no response within 500ms
                setTimeout(() => resolve(), 500);
            });
            ws.close(1000);
        });

        it("can be explicitly rejected", async () => {
            mockServer.forAnyWebSocket().thenRejectConnection(401, "Forbidden", {}, "No no no");

            const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
            });

            const result = await new Promise<'open' | Error>((resolve) => {
                ws.on('open', () => resolve('open'));
                ws.on('error', (e) => resolve(e));
            });

            expect(result).to.be.instanceOf(Error);
            expect((result as Error).message).to.equal("Unexpected server response: 401");
            ws.close(1000);
        });

        it("can be manually blocked", async () => {
            mockServer.forAnyWebSocket().thenCloseConnection();

            const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
            });

            const result = await new Promise<'open' | Error>((resolve) => {
                ws.on('open', () => resolve('open'));
                ws.on('error', (e) => resolve(e));
            });

            expect(result).to.be.instanceOf(Error);
            expect((result as Error).message).to.equal("socket hang up");
            ws.close(1000);
        });

        it("can be forced to time out", async () => {
            mockServer.forAnyWebSocket().thenTimeout();

            const ws = new WebSocket(`ws://localhost:${wsPort}`, {
                agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
            });

            const result = await new Promise<'open' | 'timeout'>((resolve) => {
                ws.on('open', () => resolve('open'));
                delay(500).then(() => resolve('timeout'));
            });

            expect(result).to.equal('timeout');

            ws.on('error', () => {});
            ws.close(1000);
        });
    });
});
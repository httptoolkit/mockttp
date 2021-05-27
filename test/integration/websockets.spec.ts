import * as WebSocket from 'isomorphic-ws';
import * as https from 'https';
import HttpProxyAgent = require('http-proxy-agent');
import HttpsProxyAgent = require('https-proxy-agent');
import { getLocal, generateCACertificate } from '../..';

import {
    expect,
    nodeOnly,
    browserOnly,
    startDnsServer,
    DestroyableServer
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
            await mockServer.anyWebSocket().thenForwardTo('ws://localhost:8694');

            const ws = new WebSocket(mockServer.url.replace('http', 'ws'));

            ws.addEventListener('open', () => ws.send('test echo'));

            const response = await new Promise((resolve, reject) => {
                ws.addEventListener('message', (evt) => resolve(evt.data));
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
    describe('Websocket requests', function() {
        this.timeout(1000);

        let mockServer = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        let wsServer: WebSocket.Server;
        let wsErrors: Error[] = [];

        beforeEach(async () => {
            await mockServer.start();
            wsErrors = [];
        });
        afterEach(async () => {
            await mockServer.stop();
            if (wsServer) {
                await new Promise((resolve) => wsServer.close(resolve));
                expect(wsErrors).to.be.empty;
            }
        });

        describe("with default rules", () => {

            describe('over HTTP', () => {

                beforeEach(async () => {
                    wsServer = new WebSocket.Server({ port: 9090 });
                    wsErrors = [];

                    // Echo every message
                    wsServer.on('connection', (ws, request) => {
                        if (request.headers['echo-header']) {
                            ws.send("echo-header: " + request.headers['echo-header']);
                        }

                        ws.on('message', (message) => {
                            ws.send(message);
                            ws.close();
                        });

                        ws.on('error', (e) => {
                            wsErrors.push(e)
                        });
                    });

                    wsServer.on('error', (e) => wsErrors.push(e));
                });

                it('can be passed through successfully over HTTP', async () => {
                    const ws = new WebSocket('ws://localhost:9090', {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', (e) => reject(e));
                    });
                    ws.close(1000);

                    expect(response).to.equal('test echo');
                });

                it("forwards the incoming requests's headers", async () => {
                    const ws = new WebSocket('ws://localhost:9090', {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`),
                        headers: {
                            'echo-header': 'a=b'
                        }
                    });

                    const response = await new Promise((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', (e) => reject(e));
                    });
                    ws.close(1000);

                    expect(response).to.equal('echo-header: a=b');
                });

                it("can handle & proxy invalid client frames upstream", async () => {
                    const ws = new WebSocket('ws://localhost:9090', {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`),
                        headers: {
                            'echo-header': 'a=b'
                        }
                    });

                    await new Promise((resolve) => {
                        ws.on('open', () => {
                            const rawWs = ws as any;

                            // Badly behaved games with the ws internals:
                            const buf = Buffer.allocUnsafe(2);
                            buf.writeUInt16BE(0);
                            rawWs._sender.doClose(buf, true, () => {
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
                    const ws = new WebSocket('ws://localhost:9090', {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', (e) => reject(e));
                    });
                    ws.close(1000);

                    expect(response).to.equal('test echo');
                });
            });

            describe('over HTTPS', () => {
                let wsHttpsServer: https.Server;

                beforeEach(async () => {
                    const ca = await getCA({
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    });
                    const cert = ca.generateCertificate('localhost');
                    wsHttpsServer = https.createServer({
                        key: cert.key,
                        cert: cert.cert
                    });

                    wsServer = new WebSocket.Server({ server: wsHttpsServer });

                    // Echo every message
                    wsServer.on('connection', (ws) => {
                        ws.on('message', (message) => {
                            ws.send(message);
                            ws.close();
                        });
                    });

                    await new Promise((resolve) => wsHttpsServer.listen(9090, resolve));
                });

                afterEach(() => new Promise((resolve) => wsHttpsServer.close(resolve)));

                it('can be passed through successfully over HTTP', async () => {
                    const ws = new WebSocket('wss://localhost:9090', {
                        agent: new HttpsProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', (e) => reject(e));
                    });
                    ws.close(1000);

                    expect(response).to.equal('test echo');
                });

                it('can be passed through successfully over HTTPS', async () => {
                    const ws = new WebSocket('wss://localhost:9090', {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const response = await new Promise((resolve, reject) => {
                        ws.on('message', resolve);
                        ws.on('error', (e) => reject(e));
                    });
                    ws.close(1000);

                    expect(response).to.equal('test echo');
                });
            });

            describe("over HTTPS with an untrusted upstream certificate", () => {

                let wsBadHttpsServer: https.Server;
                const untrustedCACert = generateCACertificate({ bits: 1024 });

                beforeEach(async () => {
                    const ca = await getCA(await untrustedCACert);
                    const cert = ca.generateCertificate('localhost');
                    wsBadHttpsServer = https.createServer({
                        key: cert.key,
                        cert: cert.cert
                    });

                    wsServer = new WebSocket.Server({ server: wsBadHttpsServer });

                    // Echo every message
                    wsServer.on('connection', (ws) => {
                        ws.on('message', (message) => {
                            ws.send(message);
                            ws.close();
                        });
                    });

                    await new Promise((resolve) => wsBadHttpsServer.listen(9090, resolve));
                });

                afterEach(() => new Promise((resolve) => wsBadHttpsServer.close(resolve)));

                it('should kill the request by default', async () => {
                    const ws = new WebSocket(`wss://localhost:9090`, {
                        agent: new HttpsProxyAgent(`https://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const error = await new Promise<Error>((resolve, reject) => {
                        ws.on('message', reject);
                        ws.on('error', (e) => resolve(e));
                    });
                    ws.close(1000);

                    expect(error.message).to.equal('socket hang up');
                });

                describe("given a trusted websocket host", () => {
                    const serverWithWhitelist = getLocal({
                        https: {
                            keyPath: './test/fixtures/test-ca.key',
                            certPath: './test/fixtures/test-ca.pem'
                        },
                        ignoreWebsocketHostCertificateErrors: [
                            'localhost:9090'
                        ]
                    });

                    beforeEach(() => serverWithWhitelist.start());
                    afterEach(() => serverWithWhitelist.stop());

                    it('should allow the request, if the host matches', async () => {
                        const ws = new WebSocket(`wss://localhost:9090`, {
                            agent: new HttpsProxyAgent(`https://localhost:${serverWithWhitelist.port}`)
                        });

                        ws.on('open', () => ws.send('test echo'));

                        const response = await new Promise<Error>((resolve, reject) => {
                            ws.on('message', resolve);
                            ws.on('error', reject);
                        });
                        ws.close(1000);

                        expect(response).to.equal('test echo');
                    });

                    it('should still block requests to other hosts', async () => {
                        // Change the WSS server port
                        await new Promise((resolve) => wsBadHttpsServer.close(resolve));
                        await new Promise((resolve) => wsBadHttpsServer.listen(9091, resolve));

                        const ws = new WebSocket(`wss://localhost:9091`, {
                            agent: new HttpsProxyAgent(`https://localhost:${serverWithWhitelist.port}`)
                        });

                        ws.on('open', () => ws.send('test echo'));

                        const error = await new Promise<Error>((resolve, reject) => {
                            ws.on('message', reject);
                            ws.on('error', (e) => resolve(e));
                        });
                        ws.close(1000);

                        expect(error.message).to.equal('socket hang up');
                    });
                });

            });

            describe("when the websocket server is unavailable", () => {

                it('should immediately close the socket', async () => {
                    const ws = new WebSocket('ws://localhost:1001', { // <- not the correct port
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const error = await new Promise<Error>((resolve, reject) => {
                        ws.on('message', reject);
                        ws.on('error', (e) => resolve(e));
                    });
                    ws.close(1000);

                    expect(error.message).to.equal('socket hang up');
                });

            });

            describe("when the websocket server rejects the request", () => {

                beforeEach(async () => {
                    wsServer = new WebSocket.Server({
                        port: 9001,
                        verifyClient: () => false // Reject all clients
                    });
                });

                it('should mirror the request rejection', async () => {
                    const ws = new WebSocket(`ws://localhost:9001`, {
                        agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                    });

                    ws.on('open', () => ws.send('test echo'));

                    const error = await new Promise<Error>((resolve, reject) => {
                        ws.on('message', reject);
                        ws.on('error', (e) => resolve(e));
                    });
                    ws.close(1000);

                    expect(error.message).to.equal('Unexpected server response: 401');
                });

            });
        });

        describe("with custom rules", () => {

            const REAL_WS_SERVER_PORT = 9123;

            beforeEach(async () => {
                // Real server that echoes every message
                wsServer = new WebSocket.Server({ port: REAL_WS_SERVER_PORT });

                wsServer.on('connection', (ws, request) => {
                    if (request.headers['echo-header']) {
                        ws.send("echo-header: " + request.headers['echo-header']);
                    }

                    ws.on('message', (message) => {
                        ws.send(message);
                        ws.close();
                    });
                });
            });

            let dnsServer: DestroyableServer | undefined;
            let fixedDnsResponse: string | undefined = undefined;

            before(async () => {
                dnsServer = await startDnsServer(() => fixedDnsResponse);
            });

            after(async () => {
                await dnsServer!.destroy();
            });

            it("can be passed through untouched", async () => {
                mockServer.anyWebSocket().thenPassThrough();

                const ws = new WebSocket(`ws://localhost:${REAL_WS_SERVER_PORT}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                ws.on('open', () => ws.send('test echo'));

                const response = await new Promise((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', (e) => reject(e));
                });
                ws.close(1000);

                expect(response).to.equal('test echo');
            });

            it("can be passed through with custom DNS resolution", async () => {
                fixedDnsResponse = '127.0.0.1'; // Send all requests to localhost

                mockServer.anyWebSocket().thenPassThrough({
                    lookupOptions: {
                        servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                    }
                });

                // Send to an invalid domain - should magically resolve regardless
                const ws = new WebSocket(`ws://nope.test:${REAL_WS_SERVER_PORT}`, {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                ws.on('open', () => ws.send('test echo'));

                const response = await new Promise((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', (e) => reject(e));
                });
                ws.close(1000);

                expect(response).to.equal('test echo');
            });

            it("can be redirected elsewhere", async () => {
                mockServer.anyWebSocket().thenForwardTo(`localhost:${REAL_WS_SERVER_PORT}`);

                // Ask for 999 (doesn't exist), and the above will forward you
                // invisibly to our real WS server elsewhere instead.
                const ws = new WebSocket('ws://localhost:999', {
                    agent: new HttpProxyAgent(`http://localhost:${mockServer.port}`)
                });

                ws.on('open', () => ws.send('test echo'));

                const response = await new Promise((resolve, reject) => {
                    ws.on('message', resolve);
                    ws.on('error', (e) => reject(e));
                });
                ws.close(1000);

                expect(response).to.equal('test echo');
            });

            it("can be manually blocked", async () => {
                mockServer.anyWebSocket().thenCloseConnection();

                const ws = new WebSocket(`ws://localhost:${REAL_WS_SERVER_PORT}`, {
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
                mockServer.anyWebSocket().thenTimeout();

                const ws = new WebSocket(`ws://localhost:${REAL_WS_SERVER_PORT}`, {
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
});
import * as WebSocket from 'ws';
import * as https from 'https';
import HttpProxyAgent = require('http-proxy-agent');
import HttpsProxyAgent = require('https-proxy-agent');
import { getLocal, generateCACertificate } from '../..';

import { expect, nodeOnly } from '../test-utils';
import { getCA } from '../../src/util/tls';
import { delay } from '../../src/util/util';

import { HackyHttpsProxyAgent } from '../test-agents';

// TODO: Create browsers tests as well (need a way to set up a websocket
// server from inside a browser though...)

nodeOnly(() => {
    describe('Websocket requests', function() {
        this.timeout(1000);

        let mockServer = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => mockServer.start());
        afterEach(() => mockServer.stop());

        describe("with default rules", () => {

            describe('over HTTP', () => {

                let wsServer: WebSocket.Server;

                beforeEach(async () => {
                    wsServer = new WebSocket.Server({ port: 9090 });

                    // Echo every message
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

                afterEach(() => wsServer.close());

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

                it('can be passed through successfully over HTTPS', async () => {
                    const ws = new WebSocket('ws://localhost:9090', {
                        /*
                        Unclear why, but npm's HttpsProxyAgent fails here (never
                        gives WS a live socket). Manually doing the same correct
                        requests works fine... This needs further investigation,
                        but probably only once WebSockets themselves get proper
                        in-depth support.

                        For now, use this hacky but effective reimplementation
                        of what I think the proxy agent _should_ do.
                        */
                        agent: HackyHttpsProxyAgent({
                            proxyHost: 'localhost',
                            proxyPort: mockServer.port
                        })
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

                    const wsServer = new WebSocket.Server({ server: wsHttpsServer });

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

                    const wsServer = new WebSocket.Server({ server: wsBadHttpsServer });

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
                    afterEach(() => serverWithWhitelist.start());

                    it('should allow the request, if the host matches', async () => {
                        const ws = new WebSocket(`wss://localhost:9090`, {                        agent: new HttpsProxyAgent(`https://localhost:${serverWithWhitelist.port}`)
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

                let wsServer: WebSocket.Server;

                beforeEach(async () => {
                    wsServer = new WebSocket.Server({
                        port: 9001,
                        verifyClient: () => false // Reject all clients
                    });
                });

                afterEach(() => wsServer.close());

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

            let wsServer: WebSocket.Server;

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

            afterEach(() => wsServer.close());

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
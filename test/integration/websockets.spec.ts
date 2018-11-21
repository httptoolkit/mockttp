import * as WebSocket from 'ws';
import * as https from 'https';
import HttpProxyAgent = require('http-proxy-agent');
import HttpsProxyAgent = require('https-proxy-agent');
import { getLocal } from '../..';

import { expect, nodeOnly } from '../test-utils';
import { getCA } from '../../src/util/tls';
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

        describe('over HTTP', () => {

            let wsServer: WebSocket.Server;

            beforeEach(async () => {
                wsServer = new WebSocket.Server({ port: 9090 });

                // Echo every message
                wsServer.on('connection', (ws) => {
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

    });
});
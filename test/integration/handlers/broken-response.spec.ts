import * as http from 'http';

import { getLocal } from "../../..";
import {
    expect,
    fetch,
    isNode,
    nodeOnly,
    delay,
    openRawTlsSocket,
    http2ProxyRequest,
    nodeSatisfies,
    SOCKET_RESET_SUPPORTED,
    BROKEN_H1_OVER_H2_TUNNELLING
} from "../../test-utils";

describe("Broken response handlers", function () {

    describe("for HTTP requests", () => {

        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should allow forcibly closing the connection", async () => {
            await server.forGet('/mocked-endpoint').thenCloseConnection();

            let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.contain(isNode ? 'socket hang up' : 'Failed to fetch');
        });

        it("should allow forcibly resetting the connection", async function () {
            if (!nodeSatisfies(SOCKET_RESET_SUPPORTED)) this.skip();

            await server.forGet('/mocked-endpoint').thenResetConnection();

            let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);

            expect(result).to.be.instanceof(Error);
            expect(result.message).to.contain('read ECONNRESET');
        });


        it("should allow leaving connections to time out", async () => {
            await server.forGet('/mocked-endpoint').thenTimeout();

            let result = await Promise.race<any>([
                fetch(server.urlFor('/mocked-endpoint')),
                delay(100).then(() => 'timed out')
            ])

            expect(result).to.equal('timed out');
        });

    })

    describe("for HTTPS requests", () => {

        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        nodeOnly(() => {
            it("should allow forcibly closing proxied connections", async function () {
                if (!nodeSatisfies(SOCKET_RESET_SUPPORTED)) this.skip();

                await server.forGet('example.com').thenResetConnection();

                const tunnel = await openRawTlsSocket(server);
                tunnel.write('CONNECT example.com:80 HTTP/1.1\r\n\r\n');
                await delay(50);
                const connectResult = tunnel.read();
                expect(connectResult.toString()).to.equal('HTTP/1.1 200 OK\r\n\r\n');

                const response: any = await new Promise((resolve, reject) =>
                    http.get({
                        createConnection: () => tunnel,
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve).on('error', reject)
                ).catch(e => e);

                expect(response).to.be.instanceof(Error);
                expect(response.message).to.contain('read ECONNRESET');
            });

            it("should allow forcibly closing h2-over-h2 proxy connections", async function () {
                if (!nodeSatisfies(SOCKET_RESET_SUPPORTED)) this.skip();

                await server.forGet('example.com').thenResetConnection();

                const response: any = await http2ProxyRequest(server, `https://example.com`)
                    .catch(e => e);

                expect(response).to.be.instanceof(Error);
                expect(response.message).to.contain(
                    'Stream closed with error code NGHTTP2_INTERNAL_ERROR'
                );
            });

            it("should allow forcibly closing h1.1-over-h2 proxy connections", async function () {
                if (!nodeSatisfies(SOCKET_RESET_SUPPORTED)) this.skip();
                if (nodeSatisfies(BROKEN_H1_OVER_H2_TUNNELLING)) this.skip();

                await server.forGet('example.com').thenResetConnection();

                const response: any = await http2ProxyRequest(server, `https://example.com`, {
                    http1Within: true
                }).catch(e => e);

                expect(response).to.be.instanceof(Error);
                expect(response.message).to.contain(
                    'Stream closed with error code NGHTTP2_CONNECT_ERROR'
                );
            });

        });

    });

});
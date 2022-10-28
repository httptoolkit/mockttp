import _ = require("lodash");
import * as net from 'net';
import request = require("request-promise-native");

import { getLocal } from "../../..";
import {
    expect,
    nodeOnly,
    startDnsServer,
    DestroyableServer,
} from "../../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp configured to proxy traffic with custom DNS", function () {

        this.timeout(5000); // Sometimes these can take a little while, DNS failures can be slow

        let dnsServer: (DestroyableServer<net.Server>) | undefined;
        let fixedDnsResponse: string | undefined = undefined;

        before(async () => {
            dnsServer = await startDnsServer(() => fixedDnsResponse);
        });

        after(async () => {
            await dnsServer!.destroy();
        });

        let server = getLocal();;
        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
            await server.start();
            process.env = _.merge({}, process.env, server.proxyEnv);

            fixedDnsResponse = undefined;
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        it("should use default DNS settings given an empty object", async () => {
            await server.forAnyRequest().thenPassThrough({
                lookupOptions: {}
            });

            await expect(
                request.get("http://not-a-real-server.test:${remoteServer.port}")
            ).to.be.rejectedWith("ENOTFOUND"); // Goes nowhere
        });

        it("should use custom DNS servers when provided", async () => {
            remoteServer.forAnyRequest().thenReply(200, "remote localhost server");
            fixedDnsResponse = '127.0.0.1'; // Resolve everything to localhost

            await server.forAnyRequest().thenPassThrough({
                lookupOptions: {
                    servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                }
            });

            const response = await request.get(`http://still-not-real.test:${remoteServer.port}`);

            expect(response).to.equal("remote localhost server");
        });

        it("should fall back to default DNS servers when custom servers can't resolve", async function () {
            remoteServer.forAnyRequest().thenReply(200, "remote localhost server");
            this.timeout(10000);

            fixedDnsResponse = undefined; // Don't resolve anything

            await server.forAnyRequest().thenPassThrough({
                lookupOptions: {
                    servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                }
            });

            const response = await request.get({
                url: `http://local.httptoolkit.tech:${remoteServer.port}`, // Really does resolve to localhost
                resolveWithFullResponse: true
            });

            await expect(response.statusCode).to.equal(200);
        });
    });
});
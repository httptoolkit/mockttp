import { getLocal } from "../../..";
import {expect, fetch, Headers, nodeOnly} from "../../test-utils";
import * as request from 'request-promise-native';

nodeOnly(() => {
    describe("Cookie matching", function () {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        beforeEach(() => {
            server.get("/")
                .withCookie({"supercookie": "yummi"})
                .thenReply(200, "matched cookie");
        });

        it("should match requests with the matching cookie", async () => {
            const requestCookie = request.cookie('supercookie=yummi');
            const cookiejar = request.jar();

            cookiejar.setCookie(requestCookie, server.url);

            const response = await request({
                uri: server.url,
                jar: cookiejar
            });

            expect(response).to.equal("matched cookie");
        });

        it("should match requests with the matching cookie when multiple cookies are present", async () => {
            const matchingCookie = request.cookie('supercookie=yummi');
            const notMatchingCookie = request.cookie('megacookie=delicious');
            const cookiejar = request.jar();

            cookiejar.setCookie(matchingCookie, server.url);
            cookiejar.setCookie(notMatchingCookie, server.url);

            const response = await request({
                uri: server.url,
                jar: cookiejar
            });

            expect(response).to.equal("matched cookie");
        });

        it("should not match requests when cookie has a different value", async () => {
            const requestCookie = request.cookie('megacookie=delicious; supercookie=delicious');
            const cookiejar = request.jar();

            cookiejar.setCookie(requestCookie, server.url);

            const { statusCode } = await request({
                uri: server.url,
                jar: cookiejar,
                resolveWithFullResponse: true,
                simple: false
            })

            expect(statusCode).to.equal(503);
        });

        it("should not match requests when no cookies are present", async () => {
            const { statusCode } = await request({
                uri: server.url,
                resolveWithFullResponse: true,
                simple: false
            })

            expect(statusCode).to.equal(503);
        });
    });
});

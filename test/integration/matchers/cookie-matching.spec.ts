import * as _ from 'lodash';
import { getLocal } from "../../..";
import { expect, isNode } from "../../test-utils";
import * as request from 'request-promise-native';

const requestWithCookies = async (url: string, ...cookies: string[]) => {
    if (isNode) {
        const cookieJar = request.jar();

        _.forEach(cookies, (cookieString) => {
            const cookie = request.cookie(cookieString)!;
            cookieJar.setCookie(cookie, url);
        });

        return request({ uri: url, jar: cookieJar });
    } else {
        const existingCookies = document.cookie.split('; ');
        _.forEach(existingCookies, (cookie) => {
            const [key] = cookie.split('=');
            document.cookie = `${key}=`; // Blank the value of all existing cookies
        });
        _.forEach(cookies, (cookie) => document.cookie = cookie);

        const response = await fetch(url, { credentials: 'include' });
        return await response.text();
    }
};

describe("Cookie matching", function () {
    let server = getLocal({ cors: false });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(() => {
        const headers: _.Dictionary<string> = isNode ? {} : {
            // Can't just use 'A-C-A-O: *', because fetch will refuse to expose
            // the response unless the server specificly confirms the origin.
            'Access-Control-Allow-Origin': window.origin,
            'Access-Control-Allow-Credentials': 'true'
        };

        return Promise.all([
            server.forGet("/")
                .withCookie({"supercookie": "yummi"})
                .always()
                .thenReply(200, "matched cookie", headers),
            server.forGet("/")
                .always()
                .thenReply(200, "did not match cookie", headers)
        ]);
    });

    it("should match requests with the matching cookie", async () => {
        const body = await requestWithCookies(server.url, 'supercookie=yummi');
        expect(body).to.equal("matched cookie");
    });

    it("should match requests with the matching cookie when multiple cookies are present", async () => {
        const body = await requestWithCookies(server.url,
            'supercookie=yummi',
            'megacookie=delicious'
        );
        expect(body).to.equal("matched cookie");
    });

    it("should not match requests when cookie has a different value", async () => {
        const body= await requestWithCookies(server.url,
            'megacookie=delicious; supercookie=delicious',
        );
        expect(body).to.equal('did not match cookie');
    });

    it("should not match requests when no cookies are present", async () => {
        const body = await requestWithCookies(server.url);
        expect(body).to.equal('did not match cookie');
    });
});

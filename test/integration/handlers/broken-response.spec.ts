import * as semver from 'semver';

import { getLocal } from "../../..";
import { expect, fetch, isNode, delay, SOCKET_RESET_SUPPORTED } from "../../test-utils";

describe("Broken response handlers", function () {

    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow forcibly closing the connection", async () => {
        await server.forGet('/mocked-endpoint').thenCloseConnection();

        let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);

        expect(result).to.be.instanceof(Error);
        expect(result.message).to.contain(isNode ? 'socket hang up' : 'Failed to fetch');
    });

    it("should allow forcibly closing the connection", async function () {
        if (!semver.satisfies(process.version, SOCKET_RESET_SUPPORTED)) this.skip();

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

});
import * as semver from 'semver';

import { getLocal } from "../..";
import {
    expect,
    File,
    fetch as fetchPolyfill,
    NATIVE_FETCH_SUPPORTED
} from "../test-utils";

const fetch = globalThis.fetch ?? fetchPolyfill;

describe("Body getXFormData methods", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    describe("given application/x-www-form-urlencoded data", () => {
        it("should automatically parse form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: "id=123&id=456&id=789&order=desc"
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getFormData()).to.deep.equal({
                id: ["123", "456", "789"],
                order: "desc",
            });
        });

        it("should explicitly parse as url-encoded form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: "id=123&id=456&id=789&order=desc"
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getUrlEncodedFormData()).to.deep.equal({
                id: ["123", "456", "789"],
                order: "desc",
            });
        });

        it("should fail to explicitly parse as multipart form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: "id=123&id=456&id=789&order=desc"
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getMultipartFormData()).to.equal(undefined);
        });
    });

    describe("given multipart/form-data", () => {
        before(function () {
            // Polyfill fetch encodes polyfill FormData into "[object FormData]", which is not parsable
            if (!semver.satisfies(process.version, NATIVE_FETCH_SUPPORTED)) this.skip();
        });

        it("should automatically parse as form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            const formData = new FormData();
            formData.append("id", "123");
            formData.append("id", "456");
            formData.append("id", "789");
            formData.append("order", "desc");
            formData.append("readme", new File(["file content"], "file.txt", {type: "text/plain"}));
            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: formData,
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getFormData()).to.deep.equal({
                id: ["123", "456", "789"],
                order: "desc",
                readme: "file content",
            });
        });

        it("should explicitly parse as multipart form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            const formData = new FormData();
            formData.append("id", "123");
            formData.append("id", "456");
            formData.append("id", "789");
            formData.append("order", "desc");
            formData.append("readme", new File(["file content"], "file.txt", {type: "text/plain"}));
            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: formData,
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getMultipartFormData()).to.deep.equal([
                { name: 'id', data: Buffer.from('123') },
                { name: 'id', data: Buffer.from('456') },
                { name: 'id', data: Buffer.from('789') },
                { name: 'order', data: Buffer.from('desc') },
                { name: 'readme', data: Buffer.from('file content'), filename: 'file.txt', type: 'text/plain' },
            ]);
        });


        it("should fail to explicitly parse as url-encoded form data", async () => {
            const endpoint = await server.forPost("/mocked-endpoint").thenReply(200);

            const formData = new FormData();
            formData.append("id", "123");
            formData.append("id", "456");
            formData.append("id", "789");
            formData.append("order", "desc");
            formData.append("readme", new File(["file content"], "file.txt", {type: "text/plain"}));
            await fetch(server.urlFor("/mocked-endpoint"), {
                method: "POST",
                body: formData,
            });

            const requests = await endpoint.getSeenRequests();
            expect(requests.length).to.equal(1);
            expect(await requests[0].body.getUrlEncodedFormData()).to.equal(undefined);
        });
    });
});
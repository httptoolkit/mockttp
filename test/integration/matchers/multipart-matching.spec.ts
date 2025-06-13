import { Buffer } from 'buffer';
import { Readable } from 'stream';

import { FormDataEncoder, FormDataLike } from "form-data-encoder"

import { getLocal } from "../../..";
import { expect, fetch, Headers, FormData, File, isNode } from "../../test-utils";

const fetchWithMultipartForm = (url: string, form: FormData) => {
    const formEncoder = new FormDataEncoder(form as any as FormDataLike);

    return fetch(url, {
        method: 'POST',
        ...(isNode
            ? {
                headers: formEncoder.headers,
                body: Readable.from(formEncoder) as any
            }
            : {
                body: form
            }
        )
    });
}

describe("Multipart form data matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should match requests by form field name", async () => {
        await server.forPost("/")
            .withMultipartForm({ name: 'text-field' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('text-field', 'text content');

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("should match requests by form field text content", async () => {
        await server.forPost("/")
            .withMultipartForm({ content: 'text content' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('text-field', 'text content');

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("should match requests by form field name and text content", async () => {
        await server.forPost("/")
            .withMultipartForm({
                name: 'text-field', content: 'text content'
            })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('text-field', 'text content');

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("should match requests by uploaded filename", async () => {
        await server.forPost("/")
            .withMultipartForm({ filename: 'my-file.txt' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('file-upload', new File(['file content'], 'my-file.txt'));

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("should match requests by uploaded file string content", async () => {
        await server.forPost("/")
            .withMultipartForm({ content: 'file content' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('file-upload', new File(['file content'], 'my-file.txt'));

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("should match requests by uploaded file buffer content", async () => {
        await server.forPost("/")
            .withMultipartForm({ content: Buffer.from('raw content', 'utf8') })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('file-upload', new File([Buffer.from('raw content', 'utf8')], 'my-file.txt'));

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).to.have.responseText("matched");
    });

    it("shouldn't match requests with the wrong field name", async () => {
        await server.forPost("/")
            .withMultipartForm(
                { name: 'text-field', content: "text content" }
            )
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('wrong-field', 'text content');

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).not.to.have.responseText("matched");
    });

    it("shouldn't match requests with the wrong filename", async () => {
        await server.forPost("/")
            .withMultipartForm({ filename: 'my-file.txt' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('file-upload', new File(['file content'], 'wrong-filename.gif'));

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).not.to.have.responseText("matched");
    });

    it("shouldn't match requests with the wrong field content", async () => {
        await server.forPost("/")
            .withMultipartForm(
                { name: 'text-field', content: "text content" }
            )
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('text-field', 'wrong content');

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).not.to.have.responseText("matched");
    });

    it("shouldn't match requests with the wrong file content", async () => {
        await server.forPost("/")
            .withMultipartForm({ content: 'file content' })
            .thenReply(200, "matched");

        let form = new FormData();
        form.set('file-upload', new File(['wrong file content'], 'my-file.txt'));

        return expect(
            fetchWithMultipartForm(server.url, form)
        ).not.to.have.responseText("matched");
    });

    it("shouldn't match urlencoded requests with the equivalent form data", async () => {
        await server.forPost("/")
            .withMultipartForm(
                { name: 'text-field', content: "text content" }
            )
            .thenReply(200, "matched");

        let form = new URLSearchParams();
        form.set('text-field', 'text content');

        return expect(fetch(server.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form
        })).not.to.have.responseText("matched");
    });

    it("shouldn't match requests without form data", async () => {
        await server.forPost("/")
            .withMultipartForm(
                { name: 'text-field', content: "text content" }
            )
            .thenReply(200, "matched");

        return expect(fetch(server.url, {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'multipart/form-data; boundary=-----------qweasd'
            }),
        })).not.to.have.responseText("matched");
    });
});

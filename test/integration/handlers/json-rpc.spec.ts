import { getLocal } from "../../..";
import { expect } from "../../test-utils";

describe("JSON-RPC methods", () => {

    const server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("can match and mock a successful JSON-RPC request", async () => {
        await server.forJsonRpcRequest()
            .thenSendJsonRpcResult({ value: 'mock-result' });

        const response = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '1234',
                method: 'getValue',
                params: []
            })
        });

        expect(response.ok).to.equal(true);
        expect(await response.json()).to.deep.equal({
            jsonrpc: '2.0',
            id: '1234',
            result: { value: 'mock-result' }
        });
    });

    it("can match against specific JSON-RPC methods", async () => {
        await server.forJsonRpcRequest({
            method: 'getValue'
        }).thenSendJsonRpcResult({ value: 'mock-result' });

        const matchingResponse = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '1',
                method: 'getValue',
                params: []
            })
        });

        const nonMatchingResponse = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '2',
                method: 'someOtherMethod',
                params: []
            })
        });

        expect(matchingResponse.ok).to.equal(true);
        expect(nonMatchingResponse.ok).to.equal(false)
        expect(await nonMatchingResponse.text()).to.include(
            'No rules were found matching this request'
        );
    });

    it("can match against specific JSON-RPC params", async () => {
        await server.forJsonRpcRequest({
            params: [{
                fieldA: 'value-to-match'
            }]
        }).thenSendJsonRpcResult({ value: 'mock-result' });

        const matchingResponse = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '1',
                method: 'getValue',
                params: [{
                    fieldA: 'value-to-match',
                    fieldB: 'another-ignored-field'
                }]
            })
        });

        const nonMatchingResponse = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '2',
                method: 'getValue',
                params: [] // No params at all
            })
        });

        expect(matchingResponse.ok).to.equal(true);
        expect(nonMatchingResponse.ok).to.equal(false)
        expect(await nonMatchingResponse.text()).to.include(
            'No rules were found matching this request'
        );
    });

    it("can match and mock a JSON-RPC error", async () => {
        await server.forJsonRpcRequest()
            .thenSendJsonRpcError({ code: 123, message: 'mock-error' });

        const response = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '1234',
                method: 'getValue',
                params: []
            })
        });

        expect(response.ok).to.equal(true);
        expect(await response.json()).to.deep.equal({
            jsonrpc: '2.0',
            id: '1234',
            error: { code: 123, message: 'mock-error' }
        });
    });

    it("does not match against non-JSON-RPC methods", async () => {
        await server.forJsonRpcRequest({
            method: 'getValue'
        }).thenSendJsonRpcResult({ value: 'mock-result' });

        const response = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'hi there'
        });

        expect(response.ok).to.equal(false);
        expect(await response.text()).to.include(
            'No rules were found matching this request'
        );
    });

    it("should reject matched non-JSON-RPC requests explicitly", async () => {
        await server.forAnyRequest() // Matching anything, not just JSON-RPC
            .thenSendJsonRpcResult({ value: 'mock-result' });

        const response = await fetch(server.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'hi there'
        });

        expect(response.ok).to.equal(false);
        expect(await response.text()).to.deep.equal(
            "Error: Can't send a JSON-RPC response to an invalid JSON-RPC request"
        );
    });

});
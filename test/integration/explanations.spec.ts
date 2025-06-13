import { getLocal } from "../..";
import { expect, fetch, URLSearchParams, Headers, isNode } from "../test-utils";
import * as _ from "lodash";
import { Readable } from 'stream';

describe("Mockttp explanation messages", function () {

    this.timeout(5000);

    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should explain fully explain the completion rules used", async () => {
        await server.forGet("/endpoint").once().thenReply(200, "1");
        await server.forGet("/endpoint").twice().thenReply(200, "2/3");
        await server.forGet("/endpoint").thrice().thenReply(200, "4/5/6");
        await server.forGet("/endpoint").times(4).thenReply(200, "7/8/9/10");
        await server.forGet("/endpoint").always().thenReply(200, "forever");

        let response = await fetch(server.urlFor("/non-existent-endpoint"));
        let responseText = await response.text();

        expect(responseText).to.include(`
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });

    it("should explain whether completion rules are completed, or still waiting", async () => {
        await server.forGet("/endpoint").once().thenReply(200, "1");
        await server.forGet("/endpoint").twice().thenReply(200, "2/3");
        await server.forGet("/endpoint").thrice().thenReply(200, "4/5/6");
        await server.forGet("/endpoint").times(4).thenReply(200, "7/8/9/10");
        await server.forGet("/endpoint").always().thenReply(200, "forever");

        await Promise.all(
            _.range(8).map(() => fetch(server.urlFor("/endpoint")))
        );

        let response = await fetch(server.urlFor("/non-existent-endpoint"));
        let responseText = await response.text();

        expect(responseText).to.include(`
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 2).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });

    it("should explain more complex rules", async () => {
        await server.forAnyRequest().withHeaders({ 'h': 'v' }).thenStream(200, new Readable());
        await server.forGet(/\/endpointA\/\d+/).once().thenReply(200, "nice request!");
        await server.forPost("/endpointB").withForm({ key: 'value' }).thenReply(500);
        await server.forPost("/endpointC").withJsonBody({ key: 'value' }).thenReply(500);
        await server.forPut("/endpointD").withQuery({ a: 1 }).always().thenCloseConnection();
        await server.forPut("/endpointE").forHost('abc.com').withExactQuery('?').thenTimeout();
        await server.forAnyWebSocket().thenForwardTo("google.com");

        await fetch(server.urlFor("/endpointA/123"));
        let response = await fetch(server.urlFor("/non-existent-endpoint"));

        let text = await response.text();

        expect(text).to.include(`No rules were found matching this request.`);
        expect(text).to.include(`The configured rules are:
Match requests for anything with headers including {"h":"v"}, and then respond with status 200 and a stream of response data.
Match requests making GETs matching //endpointA/\\d+/, and then respond with status 200 and body "nice request!", once (done).
Match requests making POSTs, for /endpointB, and with form data including {"key":"value"}, and then respond with status 500.
Match requests making POSTs, for /endpointC, and with a JSON body equivalent to {"key":"value"}, and then respond with status 500.
Match requests making PUTs, for /endpointD, and with a query including {"a":"1"}, and then close the connection, always (seen 0).
Match requests making PUTs, for /endpointE, for host abc.com, and with a query exactly matching \`?\`, and then time out (never respond).
Match websockets for anything, and then forward the websocket to google.com.
`);
    });

    it("should explain callback handlers", async () => {
        await server.forPost("/endpointA").thenCallback(() => ({}));
        await server.forPost("/endpointB").thenCallback(function handleRequest() { return {}; });

        let response = await fetch(server.urlFor("/non-existent-endpoint"));
        let text = await response.text();

        expect(text).to.include(`The configured rules are:
Match requests making POSTs for /endpointA, and then respond using provided callback.
Match requests making POSTs for /endpointB, and then respond using provided callback (handleRequest).
`);
    });

    it("should explain received unmatched requests", async () => {
        await expect(fetch(server.urlFor("/endpoint")))
        .to.have.responseText(
            /This request was: GET request to http:\/\/localhost:\d+\/endpoint/
        );
    });

    it("should explain the headers of received unmatched requests", async () => {
        await expect(fetch(server.urlFor("/endpoint"), {
            headers: new Headers({
                abc: '123'
            })
        })).to.have.responseText(
            /This request was: GET request to http:\/\/localhost:\d+\/endpoint with headers:\n{[.\s\S]+"abc": "123"[.\s\S]+}/
        );
    });

    it("should explain the body of received unmatched requests", async () => {
        let form = new URLSearchParams();
        form.set('a', '123');

        await expect(fetch(server.urlFor("/endpoint"), {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
            body: form
        })).to.have.responseText(
            /This request was: POST request to http:\/\/localhost:\d+\/endpoint with body `a=123`/
        );
    });

    it("should provide suggestions for new GET rules you could use", async () => {
        let response = await fetch(server.urlFor("/endpoint"));

        let text = await response.text();

        expect(text).to.include(`You can fix this by adding a rule to match this request, for example:
mockServer.forGet("/endpoint").thenReply(200, "your response");`);
    });

    it("should provide suggestions for new POST rules you could use", async () => {
        let form = new URLSearchParams();
        form.set('shouldMatch', 'yes');

        let response = await fetch(server.urlFor("/endpoint"), {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
            body: form
        });

        let text = await response.text();

        expect(text).to.include(`You can fix this by adding a rule to match this request, for example:
mockServer.forPost("/endpoint").withForm({"shouldMatch":"yes"}).thenReply(200, "your response");`);
    });

    it("should explain why passthrough fails for non-proxy requests", async () => {
        await server.forGet("/endpoint").thenPassThrough();

        let result = await fetch(server.urlFor("/endpoint"));

        expect(result.status).to.equal(500);
        let body = await result.text();
        expect(body).to.include(
`Passthrough loop detected. This probably means you're sending a request directly to a passthrough endpoint, \
which is forwarding it to the target URL, which is a passthrough endpoint, which is forwarding it to the target \
URL, which is a passthrough endpoint...

You should either explicitly mock a response for this URL (http://localhost:${server.port}/endpoint), or use the server \
as a proxy, instead of making requests to it directly`);
    });

    it("should be available when inspecting endpoints", async () => {
        await server.forGet("/endpoint").twice().thenReply(200, "first response");
        await server.forGet("/endpoint").thenReply(200, "second response");

        await fetch(server.urlFor("/endpoint"));

        const endpoints = await server.getMockedEndpoints();
        if (isNode) {
            // util.inspect is used by console.log under the hood, so should be standard console.log output:
            const util = require('util');
            const explanation = util.inspect(endpoints);
            expect(explanation).to.include(
                'Match requests making GETs for /endpoint, and then respond with status 200 and body "first response", twice (seen 1).'
            );
            expect(explanation).to.include(
                'Match requests making GETs for /endpoint, and then respond with status 200 and body "second response".'
            );
        } else {
            const explanations = endpoints.map(p => (p as any).explanation);
            expect(explanations).to.deep.equal([
                'Match requests making GETs for /endpoint, and then respond with status 200 and body "first response", twice.',
                'Match requests making GETs for /endpoint, and then respond with status 200 and body "second response".'
            ]);
        }
    });
});
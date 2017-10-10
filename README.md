# HTTP Server Mock [![Travis Build Status](https://img.shields.io/travis/pimterry/http-server-mock.svg)](https://travis-ci.org/pimterry/http-server-mock)

**HTTP Server Mock is the HTTP integration tool you've been searching for these long years.**

Write JS tests that _truly_ integration test your HTTP. Quickly build a fake server, or
transparently proxy requests your code sends to other domains. Write mocks that work
universally in node and the browser. Get strong types built-in & promises throughout,
with a library designed for modern JS & async/await, and enjoy helpful debuggability
with self-explaining mocks.

HTTP Server Mock lets you truly integration test your HTTP requests with thorough
library-agnostic HTTP mocking that can mock requests from your code, your dependencies,
your subprocesses, native code, your server (from your browser), every crazy npm library
you've installed and even remote devices (if they use your machine as a proxy). See
the actual requests that would be made, and write tests that check what will really
hit the wire, and how your whole stack will handle the response, not just the function
calls you think you'll make.

HTTP integration testing is a mess, and HTTP Server Mock is here to make it better.

_This is all still in early development, not quite complete or stable, and subject to change!_

## Er, what?

Ok, let's summarize. HTTP server mock lets you:

* Write **easy, fast & reliable node.js & browser HTTP integration tests**
* Fake server responses and verify requests made by your code
* **Mock HTTP requests from inside & outside your process/browser tab**, including subprocesses, native code, remote devices, and more.
* Stub and mock requests transparently, as an **HTTP mocking proxy**, as well as serving traffic directly
* **Mock servers from both node and browsers** (universal/'isomorphic' HTTP mocking)
* **Safely mock HTTP in parallel**, with autoconfiguration of ports, mock URLs and proxy settings
* **Debug your tests easily**, with full explainability of all mock matches & misses and an extra detailed debug mode
* Use promises (and even async/await) and get **strong typing** (with TypeScript) throughout your test code

## Get Testing

```typescript
const request = require("node-fetch");
const mockServer = require("http-server-mock").getLocal();

describe("Http-server-mock", () => {
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockServer.stop());

    it("mocks requests", () => {
        return mockServer.get("/mocked-endpoint").thenReply(200, "How delightful")
        .then(() =>
            request.get("http://localhost:8080/mocked-endpoint")
        ).then((response) =>
            expect(response).to.equal("How delightful")
        );
    });

    it("works best with async/await", async () => {
        await mockServer.get("/mocked-endpoint").thenReply(200, "Tip top testing")

        // Want to be agnostic to the mock port, to run tests in parallel? Try .urlFor():
        let response = await request.get(mockServer.urlFor("/mocked-endpoint"));

        expect(response).to.equal("Tip top testing");
    });

    it("can proxy requests to made to any other hosts", async () => {
        await server.get("http://google.com").thenReply(200, "I can't believe it's not google!");

        // One of the _many_ ways to enable an HTTP proxy:
        let proxiedRequest = request.defaults({ proxy: server.url });

        let response = await proxiedRequest.get("http://google.com");

        expect(response).to.equal("I can't believe it's not google!");
    });

    it("also allows request verification", async () => {
        const endpointMock = await mockServer.get("/mocked-endpoint").thenReply(200, "what have we here?");

        await request.get(mockServer.urlFor("/mocked-endpoint"));

        const requests = await endpointMock.getSeenRequests();
        expect(requests.length).to.equal(1);
        expect(requests[0].url).to.equal("/mocked-endpoint");
    });
});
```

# Mockttp [![Travis Build Status](https://img.shields.io/travis/pimterry/mockttp.svg)](https://travis-ci.org/pimterry/mockttp)

**Mockttp is the HTTP integration tool you've been searching for these long years.**

Write JS tests that _truly_ integration test your HTTP. Quickly build a fake server, or
transparently proxy requests your code sends to other domains. Write mocks that work
universally in node and the browser. Get strong types built-in & promises throughout,
with a library designed for modern JS & async/await, and enjoy helpful debuggability
with self-explaining mocks.

Mockttp lets you truly integration test your HTTP(S) requests with thorough
library-agnostic HTTP mocking that can mock requests from your code, your dependencies,
your subprocesses, native code, your server (from your browser), every crazy npm library
you've installed and even remote devices (if they use your machine as a proxy). See
the actual requests that would be made, and write tests that check what will really
hit the wire, and how your whole stack will handle the response, not just the function
calls you think you'll make.

HTTP integration testing is a mess, and Mockttp is here to make it better.

_This is all still in early development, not quite complete or stable, and subject to change!_

## Er, what?

Ok, let's summarize. Mockttp lets you:

* Write **easy, fast & reliable node.js & browser HTTP integration tests**
* Fake server responses and verify requests made by your code
* **Intercept, mock and proxy HTTPS too**, with built-in certificate generation
* **Mock HTTP requests from inside & outside your process/tab**, including subprocesses, native code, remote devices, and more
* Stub and mock requests transparently, as an **HTTP mocking proxy**, as well as serving traffic directly
* **Mock servers for node & browsers with the same code** (universal/'isomorphic' HTTP mocking)
* **Safely mock HTTP in parallel**, with autoconfiguration of ports, mock URLs and proxy settings
* **Debug your tests easily**, with full explainability of all mock matches & misses, mock autosuggestions, and an extra detailed debug mode
* Write modern tests, with promises all the way down and **strong typing** (with TypeScript) throughout.

## Get Started

```bash
npm install --save-dev mockttp
```

## Get Testing

To run an HTTP integration test, you need to :

* Start a Mockttp server
* Mock the endpoints you're interested in
* Make some real HTTP requests
* Assert on the results

Here's a minimal example of all that, using Mocha, Chai & Superagent, which works out of the box in Node and all modern browsers:

```typescript
const superagent = require("superagent");
const mockServer = require("mockttp").getLocal();

describe("Mockttp", () => {
    // Start your server
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockserver.stop());

    it("lets you mock requests, and assert on the results", () => {
        // Mock your endpoints
        await mockServer.get("/mocked-path").thenReply(200, "A mocked response")

        // Make a request
        let response = await superagent.get("http://localhost:8080/mocked-path"));

        // Assert on the results
        expect(response.text).to.equal("A mocked response");
    });
});
```

Easy! Let's take a look at some of the more fancy features:

```typescript
const superagent = require("superagent");
const mockServer = require("mockttp").getLocal();

describe("Mockttp", () => {
    // Note there's no start port here!
    beforeEach(() => mockServer.start());
    afterEach(() => mockServer.stop());

    it("lets you mock without specifying a port, allowing parallel testing", async () => {
        await mockServer.get("/mocked-endpoint").thenReply(200, "Tip top testing")

        // Try mockServer.url or .urlFor(path) to get a unique URL
        let response = await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        expect(response.text).to.equal("Tip top testing");
    });

    it("lets you verify the request details the mockttp server receives", async () => {
        const endpointMock = await mockServer.get("/mocked-endpoint").thenReply(200, "hmm?");

        await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        const requests = await endpointMock.getSeenRequests();
        expect(requests.length).to.equal(1);
        expect(requests[0].url).to.equal("/mocked-endpoint");
    });

    it("lets you proxy requests made to any other hosts", async () => {
        await mockServer.get("http://google.com").thenReply(200, "I can't believe it's not google!");

        // One of the many ways to use a proxy - this assumes Node & superagent-proxy.
        // In a browser, you can simply use the browser settings instead.
        let response = await superagent.get("http://google.com").proxy(server.url);

        expect(response).to.equal("I can't believe it's not google!");
    });
});
```

These examples uses Mocha, Chai and Superagent, but none of those are required: Mockttp will work with any testing tools that can handle promises (and with minor tweaks, many that can't), and can mock requests from any library, tool or device you might care to use.

## Documentation

* [In-depth setup guide](docs/setup.md)
* [API reference](https://pimterry.github.io/mockttp/modules/mockttp.html)

## Credits

* Many thanks to https://github.com/vieiralucas for donating the package name!
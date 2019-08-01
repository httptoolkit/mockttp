# Mockttp [![Travis Build Status](https://img.shields.io/travis/httptoolkit/mockttp.svg)](https://travis-ci.org/httptoolkit/mockttp) [![Available on NPM](https://img.shields.io/npm/v/mockttp.svg)](https://npmjs.com/package/mockttp)  [![Try Mockttp on RunKit](https://badge.runkitcdn.com/mockttp.svg)](https://npm.runkit.com/mockttp)

> _Part of [HTTP Toolkit](https://httptoolkit.tech): powerful tools for building, testing & debugging HTTP(S)_

**Mockttp lets you quickly & reliably test HTTP requests & responses in JavaScript, in both Node and browsers.**

There's a lot of tools to do this, but typically by stubbing the HTTP functions in your
process at the JS level. That ties you to a specific environment, doesn't test the
real requests that'd be made, and only works for requests made in the same JS processs.
It's inflexible, limiting and inaccurate, and often unreliable & tricky to debug too.

Mockttp is here to make this better.

Mockttp allows you to do accurate true integration testing, writing one set of tests that
works out of the box in node or browsers, with support for transparent proxying & HTTPS,
strong typing & promises throughout, fast & safe parallel testing, and helpful
built-in debuggability support all the way down.

## Features

Let's get specific. Mockttp lets you:

* Write **easy, fast & reliable node.js & browser HTTP integration tests**
* **Stub server responses** and **verify HTTP requests** made by your code
* **Intercept HTTPS** too, with built-in self-signed certificate generation
* **Mock requests inside or outside your process/tab**, including subprocesses, native code, remote devices, and more
* **Test true real-world behaviour**, verifying the real requests made, and testing exactly how your whole stack will handle a response in reality
* Stub direct requests, or transparently stub requests elsewhere as an **HTTP mocking proxy**
* **Mock for node & browser tests with the same code** (universal/'isomorphic' HTTP mocking)
* **Safely mock HTTP in parallel**, with autoconfiguration of ports, mock URLs and proxy settings, for super-charged integration testing
* **Debug your tests easily**, with full explainability of all mock matches & misses, mock autosuggestions, and an extra detailed debug mode
* Write modern test code, with promises all the way down, async/await, and **strong typing** (with TypeScript) throughout

## Get Started

```bash
npm install --save-dev mockttp
```

## Get Testing

To run an HTTP integration test, you need to:

* Start a Mockttp server
* Mock the endpoints you're interested in
* Make some real HTTP requests
* Assert on the results

Here's a simple minimal example of all that using plain promises, Mocha, Chai & Superagent, which works out of the box in Node and modern browsers:

```typescript
const superagent = require("superagent");
const mockServer = require("mockttp").getLocal();

describe("Mockttp", () => {
    // Start your server
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockServer.stop());

    it("lets you mock requests, and assert on the results", () =>
        // Mock your endpoints
        mockServer.get("/mocked-path").thenReply(200, "A mocked response")
        .then(() => {
            // Make a request
            return superagent.get("http://localhost:8080/mocked-path");
        }).then(response => {
            // Assert on the results
            expect(response.text).to.equal("A mocked response");
        })
    );
});
```

(Want to play with this yourself? Try running a standalone version live on RunKit: https://npm.runkit.com/mockttp)

That is pretty easy, but we can make this simpler & more powerful. Let's take a look at some more fancy features:

```typescript
const superagent = require("superagent");
require('superagent-proxy')(superagent);
const mockServer = require("mockttp").getLocal();

describe("Mockttp", () => {
    // Note that there's no start port here, so we dynamically find a free one instead
    beforeEach(() => mockServer.start());
    afterEach(() => mockServer.stop());

    it("lets you mock without specifying a port, allowing parallel testing", async () => {
        // Simplify promises with async/await in supported environments (Chrome 55+/Node 8+/Babel/TypeScript)
        await mockServer.get("/mocked-endpoint").thenReply(200, "Tip top testing")

        // Try mockServer.url or .urlFor(path) to get a the dynamic URL for the server's port
        let response = await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        expect(response.text).to.equal("Tip top testing");
    });

    it("lets you verify the request details the mockttp server receives", async () => {
        const endpointMock = await mockServer.get("/mocked-endpoint").thenReply(200, "hmm?");

        await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        // Inspect the mock to get the requests it received and assert on their details
        const requests = await endpointMock.getSeenRequests();
        expect(requests.length).to.equal(1);
        expect(requests[0].url).to.equal(`http://localhost:${mockServer.port}/mocked-endpoint`);
    });

    it("lets you proxy requests made to any other hosts", async () => {
        // Match a full URL instead of just a path to mock proxied requests
        await mockServer.get("http://google.com").thenReply(200, "I can't believe it's not google!");

        // One of the many ways to use a proxy - this assumes Node & superagent-proxy.
        // In a browser, you can simply use the browser settings instead.
        let response = await superagent.get("http://google.com").proxy(mockServer.url);

        expect(response.text).to.equal("I can't believe it's not google!");
    });
});
```

These examples uses Mocha, Chai and Superagent, but none of those are required: Mockttp will work with any testing tools that can handle promises (and with minor tweaks, many that can't), and can mock requests from any library, tool or device you might care to use.

## Documentation

* [In-depth setup guide](docs/setup.md)
* [API reference](https://httptoolkit.github.io/mockttp/modules/mockttp.html)

## Credits

* Many thanks to https://github.com/vieiralucas for donating the package name!

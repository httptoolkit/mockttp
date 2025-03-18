# Mockttp [![Build Status](https://github.com/httptoolkit/mockttp/workflows/CI/badge.svg)](https://github.com/httptoolkit/mockttp/actions) [![Available on NPM](https://img.shields.io/npm/v/mockttp.svg)](https://npmjs.com/package/mockttp)

> _Part of [HTTP Toolkit](https://httptoolkit.com): powerful tools for building, testing & debugging HTTP(S)_

**Mockttp lets you intercept, transform or test HTTP requests & responses in JavaScript - quickly, reliably & anywhere.**

You can use Mockttp for integration testing, by intercepting real requests as part of your test suite, or you can use Mockttp to build custom HTTP proxies that capture, inspect and/or rewrite HTTP in any other kind of way you like.

HTTP testing is the most common and well supported use case. There's a lot of tools to test HTTP, but typically by stubbing the HTTP functions in-process at the JS level. That ties you to a specific environment, doesn't truly test the real requests that you code would send, and only works for requests made in the same JS process. It's inflexible, limiting and inaccurate, and often unreliable & tricky to debug too.

Mockttp meanwhile allows you to do accurate true integration testing, writing one set of tests that works out of the box in node or browsers, with support for transparent proxying & HTTPS, strong typing & promises throughout, fast & safe parallel testing, and with debuggability built-in at every stage.

Mockttp is also battle-tested as a scriptable rewriting proxy, powering all the HTTP internals of [HTTP Toolkit](https://httptoolkit.com). Anything you can do with HTTP Toolkit, you can automate with Mockttp as a headless script.

## Features

Let's get specific. Mockttp lets you:

* Write **easy, fast & reliable node.js & browser HTTP integration tests**
* **Stub server responses** and **verify HTTP requests**
* **Intercept HTTPS** too, with built-in self-signed certificate generation
* **Mock requests inside or outside your process/tab**, including subprocesses, native code, remote devices, and more
* **Test true real-world behaviour**, verifying the real requests made, and testing exactly how your whole stack will handle a response in reality
* Stub direct requests as a **mock server**, or transparently stub requests sent elsewhere as an **HTTP mocking proxy**
* **Mock HTTP in both node & browser tests with the same code** (universal/'isomorphic' HTTP mocking)
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
    // Start your mock server
    beforeEach(() => mockServer.start(8080));
    afterEach(() => mockServer.stop());

    it("lets you mock requests, and assert on the results", async () => {
        // Mock your endpoints
        await mockServer.forGet("/mocked-path").thenReply(200, "A mocked response");

        // Make a request
        const response = await superagent.get("http://localhost:8080/mocked-path");

        // Assert on the results
        expect(response.text).to.equal("A mocked response");
    });
});
```

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
        await mockServer.forGet("/mocked-endpoint").thenReply(200, "Tip top testing");

        // Try mockServer.url or .urlFor(path) to get a the dynamic URL for the server's port
        let response = await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        expect(response.text).to.equal("Tip top testing");
    });

    it("lets you verify the request details the mockttp server receives", async () => {
        const endpointMock = await mockServer.forGet("/mocked-endpoint").thenReply(200, "hmm?");

        await superagent.get(mockServer.urlFor("/mocked-endpoint"));

        // Inspect the mock to get the requests it received and assert on their details
        const requests = await endpointMock.getSeenRequests();
        expect(requests.length).to.equal(1);
        expect(requests[0].url).to.equal(`http://localhost:${mockServer.port}/mocked-endpoint`);
    });

    it("lets you proxy requests made to any other hosts", async () => {
        // Match a full URL instead of just a path to mock proxied requests
        await mockServer.forGet("http://google.com").thenReply(200, "I can't believe it's not google!");

        // One of the many ways to use a proxy - this assumes Node & superagent-proxy.
        // In a browser, you can simply use the browser settings instead.
        let response = await superagent.get("http://google.com").proxy(mockServer.url);

        expect(response.text).to.equal("I can't believe it's not google!");
    });
});
```

These examples use Mocha, Chai and Superagent, but none of those are required: Mockttp will work with any testing tools that can handle promises (and with minor tweaks, many that can't), and can mock requests from any library, tool or device you might care to use.

## Documentation

* [In-depth setup guide](docs/setup.md)
* [API reference](https://httptoolkit.github.io/mockttp/)

## Credits

* Many thanks to https://github.com/vieiralucas for donating the package name!

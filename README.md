# Mockttp [![Travis Build Status](https://img.shields.io/travis/pimterry/mockttp.svg)](https://travis-ci.org/pimterry/mockttp)

Mockttp lets you quickly & reliably fake HTTP responses for testing, and assert
on the requests made by your code.

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
* **Test true real-world behaviour**, seeing the real requests made & exactly what'd really happen, not just the requests you asked for
* Stub direct requests, or transparently stub requests elsewhere as an **HTTP mocking proxy**
* **Mock in node & browser tests with the same code** (universal/'isomorphic' HTTP mocking)
* **Safely mock HTTP in parallel**, with autoconfiguration of ports, mock URLs and proxy settings, for super-charged integration testing
* **Debug your tests easily**, with full explainability of all mock matches & misses, mock autosuggestions, and an extra detailed debug mode
* Write modern test code, with promises all the way down, async/await, and **strong typing** (with TypeScript) throughout.

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
        let response = await superagent.get("http://localhost:8080/mocked-path");

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
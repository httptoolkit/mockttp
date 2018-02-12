# Setting up Mockttp

To run Mockttp tests, you need:

* A mock server, which handles your requests
* A mock server client, which configures the mock server
* Either:
    - An HTTP client configured to make requests to your mock server's URL
    - An HTTP client configured to make requests anywhere, using your mock server as a proxy
* (Optional) HTTPS configuration for your server, trusted in your client

In the below, we'll walk through the core concepts, and some concrete examples that should let you get started immediately. For a larger real world example, see the test suite & test configuration in the Mockttp project itself, which runs in Node & Chrome, uses the mock server directly and as a proxy, and mocks HTTP and HTTPS connections.

All this does of course only cover a few of the many ways to set up Mockttp. If you're in a different environment, or you have another interesting case or more details that would fit here please send a pull request!

## Setting up a mock server & client

Mockttp exposes three setup functions: `getLocal`, `getRemote` and `getStandalone`. For simple configurations you'll simply call `getLocal()` in all your test code, and start mocking & making requests. In Node nothing more is required. For browsers, you'll start a standalone management server first (more details below). The resulting client then works identically in both environments.

* `getLocal()` - returns a mock client for a local server
    - In Node, this automatically starts & stops mock servers for you within the current process.
    - In the browser, this is an alias for `getRemote()`.
* `getRemote()` - returns a mock client, making requests to a separate standalone server to manage the mock server itself.
    - This returned client has exactly the same API as `getLocal`, but makes requests to the standalone server to configure the mock server.
    - The client/server separation is required in a browser (as you cannot start an HTTP server inside a browser), but can also be useful to run tests with a mock server elsewhere on your network, e.g. to test mobile or IoT devices.
* `getStandalone()` - returns a standalone server, which remote clients can connect to start, stop & configure any number of mock servers.
    - This only works in Node, and throws an error if called in the browser.
    - You can call this directly in your own test scripting outside the browser, or run the provided `mockttp -c [test command]` helper, to have a standalone server automatically started before your tests run, and shut down afterwards.

### Server & Client Setup Examples

#### Local Node.JS Setup

1. Set up a mock server & client in-process:
    ```typescript
    const mockServer = require('mockttp').getLocal();

    // Before each test, start up the server:
    mockServer.start();
    
    // After each test, stop the server:
    mockServer.stop();
    ```

2. Direct your HTTP traffic through that server, by doing _one_ of the below:
    * Change your application's configuration to make requests to the mock server's URL (`mockServer.url`)
    * Use env vars to set your proxy settings globally, if supported by your HTTP client: `process.env = Object.assign(process.env, mockServer.proxyEnv)`
    * Use a specific setting to reconfigure your HTTP client of choice to use `mockServer.proxyEnv.HTTP_PROXY` as its proxy, if it doesn't automatically use proxy configuration from the environment.

#### Browser Setup

1. Start a standalone mock server process from outside the browser, by doing _one_ of the below:
    * Running `mockttp -c [test command]`, to start the server before your tests, and automatically shut it down afterwards.
    * If you're using a script to start your tests, you can start the standalone server from node directly:
      ```typescript
      const standaloneServer = require('mockttp').getStandalone();

      standaloneServer.start()
      .then(() => runTests())
      .finally(() => standaloneServer.stop());
      ```
2. Connect to that standalone server from inside the browser
    ```typescript
    const mockServer = require('mockttp').getLocal();

    // Before each test, start a fresh server:
    mockServer.start();
    
    // After each test, stop your server:
    mockServer.stop();
    ```

3. Direct your HTTP traffic through that server, by doing _one_ of the below:
    * Change your application's configuration to make requests to the mock server's URL (`mockServer.url`)
    * Using a fixed port for the mock server (`mockServer.start(8080)`) and configuring your test browser to use that as a proxy

#### Browser + Node.Js setup

Connecting to mock servers in both the example configurations above uses exactly the same code, so the only difference is that your browser needs a standalone server first. You can do this easily using only one set of test code by setting up your test configuration to do something like:

* Run Node tests
* Start standalone server
* Run browser tests
* Stop standalone server

## Mocking HTTPS

To mock an HTTPS server, either directly or as a proxy, you need to:

* Obtain/generate a CA certificate
* Tell Mockttp to use it
* Ensure your HTTP client trusts it.

### Generating a certificate

If you have openssl installed, you can generate a certificate with:

```bash
openssl req -x509 -new -nodes -keyout testCA.key -sha256 -days 365 -out testCA.pem -subj '/CN=Mockttp Testing CA - DO NOT TRUST'
```

This will output a private key as `testCA.key`, and a certificate as `testCA.pem`. You only need to do this once,
until it expires (see the `-days` parameter), and you can then commit this to your project. Though in general
committing a private key is a very bad idea, you should never allow anybody other than your test suite to trust this one,
so it's not a risk.

That last point is an important caveat though! **Do not trust this certificate system-wide on any machine, unless you're sure you know what you're doing**. If you share the private key anywhere outside your machine, and you trust the certificate system-wide, you are allowing any attacker to perfectly fake secure connections to anywhere you ever visit in future. Don't do that, it's not as fun as it sounds.

### Passing Mockttp a certificate

You can tell Mockttp to use a certificate you've generated by providing the path to the certificate when setting up your mock server, with:

```
const mockServer = getLocal({
    https: {
        keyPath: './testCA.key',
        certPath: './testCA.pem'
    }
});
```

The paths here should be relative to the working directory of the process running your mock server. That'll typically be the root of your project.

### Trusting a certificate

How to trust this certificate will depend on your HTTP client & test setup. You may be able to trust specific CAs in your HTTP request tool, but the simplest route is normally to trust the certificate process-wide. The process to do that is different depending on what is running your tests:

* **Node.js**: you can add CA certificates by setting the `NODE_EXTRA_CA_CERTS` environment variable to the path of your certificate (in Node 7.3+).
  Something like `NODE_EXTRA_CA_CERTS=./testCA.pem npm test` should work nicely.
* **Chrome**: you can trust a certificate by passing the `--ignore-certificate-errors-spki-list=<spki fingerprint>` flag when starting Chrome.
  To get the SPKI fingerprint for a certificate with openssl, run `openssl rsa -in testCA.key -outform der -pubout 2>/dev/null | sha256sum | xxd -r -p | base64`. Unfortunately, this is not yet supported in headless Chrome.
* **FireFox**: you'll need to manually create a Firefox profile for your tests, open a browser using that, add the certificate as a CA, and then reuse that profile in later tests.
* **Other**: most other tools will have their own way of temporarily adding an extra CA. If they don't, they may have an option to disable TLS verification in your tests entirely, or you might be able to trust your CA certificate system-wide (if you do this, ensure the private key never leaves your machine). Both of these come with security risks though, so be very careful, and make sure you know what you're doing first.

### HTTPS Setup Example

As a full example, take a look at Mockttp's own test configuration. The Mockttp test certificate was generated using the commands above, and is stored in [test/fixtures](https://github.com/pimterry/mockttp/tree/master/test/fixtures). It's configured in the mock server in the [https](https://github.com/pimterry/mockttp/blob/master/test/integration/https.spec.ts) and [proxy](https://github.com/pimterry/mockttp/blob/master/test/integration/proxy.spec.ts) tests, and marked as trusted in Node ([in package.json](https://github.com/pimterry/mockttp/blob/master/package.json#L15)) and Chrome ([in the Karma config](https://github.com/pimterry/mockttp/blob/master/karma.conf.js#L44)).
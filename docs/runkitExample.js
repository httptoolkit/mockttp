const expect = require("chai").expect;
const superagent = require("superagent");
const mockServer = require("mockttp").getLocal();

mockServer.start(8080)
.then(() => {
    // Mock your endpoints
    return mockServer.forGet("/mocked-path").thenReply(200, "A mocked response");
}).then(() => {
    // Make a request
    return superagent.get("http://localhost:8080/mocked-path");
}).then((response) => {
    // Assert on the results
    expect(response.text).to.equal("A mocked response");
    console.log("Test passed!");
});
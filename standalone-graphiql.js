/**
 * Run this script to start up a standalone server locally, and open
 * a GraphIQL page on it, so you can manually send requests and debug
 * the API directly.
 */

const graphiqlExpress = require('apollo-server-express').graphiqlExpress;
const opn = require('opn');
const Mockttp = require('.');

const standalone = Mockttp.getStandalone();
const server = Mockttp.getRemote();
const serverPort = 8000;

// Add a debug UI to the standalone server
standalone.app.use('/graphiql', graphiqlExpress({
    endpointURL: `/server/${serverPort}/`,
}));

standalone.start().then(() => {
    console.log('Standalone started');
    return server.start(serverPort);
}).then(() => {
    console.log('Mock server started');
    server.get('/').thenReply(200, 'hi!');
    opn('http://localhost:45456/graphiql')
});
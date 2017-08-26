/**
 * Run this script to start up a standalone server locally, and open
 * a GraphIQL page on it, so you can manually send requests and debug
 * the API directly.
 */

var graphiqlExpress = require('apollo-server-express').graphiqlExpress;
var opn = require('opn');
var httpServerMock = require('.');

var standalone = httpServerMock.getStandalone();
// Add a debug UI to the server
standalone.app.use('/graphiql', graphiqlExpress({
    endpointURL: '/graphql',
}));

standalone.start().then(() => {
    console.log('Server started');
    opn('http://localhost:45456/graphiql')
});
#!/usr/bin/env node
var childProcess = require('child_process');

var args = process.argv;
if (args[2] !== '-c' || args[3] == null) {
    console.log("Usage: http-server-mock -c <test command>");
    process.exit(1);
}

startMockServer().then(function (server) {
    var realCommand = args.slice(3).join(' ');
    var realProcess = childProcess.spawn(realCommand, [], {
        shell: true,
        stdio: 'inherit',
    });

    realProcess.on('error', function (error) {
        server.stop().then(function () {
            console.error(error);
            process.exit(1);
        });
    });

    realProcess.on('exit', function (code, signal) {
        server.stop().then(function () {
            if (code == null) {
                console.error('Executed process exited due to signal: ' + signal);
                process.exit(1);
            } else {
                process.exit(code);
            }
        });
    });
}).catch((e) => {
    console.error(e);
    process.exit(1);
});

function startMockServer() {
    var standaloneServer = require('../..').getStandalone();
    return standaloneServer.start().then(function () {
        return standaloneServer;
    });
}
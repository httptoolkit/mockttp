#!/usr/bin/env node
import childProcess = require('child_process');
import HttpServerMock = require('../..');

let args = process.argv;
if (args[2] !== '-c' || args[3] == null) {
    console.log("Usage: http-server-mock -c <test command>");
    process.exit(1);
}

const server = HttpServerMock.getStandalone();
server.start().then(() => {
    let realCommand = args.slice(3).join(' ');
    let realProcess = childProcess.spawn(realCommand, [], {
        shell: true,
        stdio: 'inherit',
    });

    realProcess.on('error', (error) => {
        server.stop().then(function () {
            console.error(error);
            process.exit(1);
        });
    });

    realProcess.on('exit', (code, signal) => {
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
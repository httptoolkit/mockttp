#!/usr/bin/env node
import childProcess = require('child_process');
import Mockttp = require('../main');

handleArgs(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
});

async function handleArgs(args: string[]) {
    let debug = false;
    let port = undefined;

    const remainingArgs = args.slice(2);
    let nextArg = remainingArgs.shift();
    while (nextArg) {
        if (nextArg === '-c') {
            await runCommandWithServer(remainingArgs.join(' '), debug, port);
            return;
        } else if (nextArg === '-d') {
            debug = true;
        } else if (nextArg === '-p') {
            port = parseInt(remainingArgs.shift()!, 10);
            if (Object.is(port, NaN)) break;
        } else {
            break;
        }

        nextArg = remainingArgs.shift();
    }

    console.log("Usage: mockttp [-d] [-p 45454] -c <test command>");
    process.exit(1);
}

async function runCommandWithServer(command: string, debug: boolean, port?: number) {
    const server = Mockttp.getAdminServer({ debug });
    await server.start(port);

    let realProcess = childProcess.spawn(command, [], {
        shell: true,
        stdio: 'inherit'
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
}
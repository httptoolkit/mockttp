#!/usr/bin/env node
/**
 * @module Internal
 */

import _ = require('lodash');
import childProcess = require('child_process');
import Mockttp = require('../main');

handleArgs(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
});

async function handleArgs(args: string[]) {
    let debug = false;

    for (let i of _.range(2, args.length)) {
        if (args[i] === '-c') {
            let remainingArgs = args.slice(i+1);
            await runCommandWithServer(remainingArgs.join(' '), debug);
            return;
        } else if (args[i] === '-d') {
            debug = true;
        } else {
            break;
        }
    }

    console.log("Usage: mockttp -c <test command>");
    process.exit(1);
}

async function runCommandWithServer(command: string, debug: boolean) {
    const server = Mockttp.getStandalone({ debug });
    await server.start();

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
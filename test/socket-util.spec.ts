import * as net from 'net';

import { expect, nodeOnly } from './test-utils';
import { isLocalPortActive } from '../src/util/socket-util';

// A free port: bind to port 0, note the port we were given, then release it.
const getFreePort = () => new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
    });
});

nodeOnly(() => {
    describe("isLocalPortActive", () => {

        it("reports an unused port as inactive and a bound port as active", async () => {
            const freePort = await getFreePort();
            expect(await isLocalPortActive('127.0.0.1', freePort)).to.equal(false);

            const server = net.createServer();
            await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
            const { port: boundPort } = server.address() as net.AddressInfo;

            try {
                expect(await isLocalPortActive('127.0.0.1', boundPort)).to.equal(true);
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });

        it("doesn't leak listeners on the shared probe server across many probes", async () => {
            const warnings: Error[] = [];
            const onWarning = (warning: Error) => {
                if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
            };
            process.on('warning', onWarning);

            try {
                // Distinct ports, so every check runs a real probe rather than hitting the cache.
                // Each kind runs in a row, more often than the default limit of 10 listeners: an
                // 'error' event would also clear stale 'error' listeners left by earlier probes.
                for (let i = 0; i < 12; i++) {
                    expect(await isLocalPortActive('127.0.0.1', await getFreePort())).to.equal(false);
                }

                const servers: net.Server[] = [];
                for (let i = 0; i < 12; i++) {
                    const server = net.createServer();
                    await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
                    servers.push(server);
                    const { port } = server.address() as net.AddressInfo;
                    expect(await isLocalPortActive('127.0.0.1', port)).to.equal(true);
                }

                await Promise.all(servers.map((server) =>
                    new Promise<void>((resolve) => server.close(() => resolve()))
                ));

                // Warnings are emitted asynchronously:
                await new Promise((resolve) => setImmediate(resolve));
                expect(warnings).to.deep.equal([]);
            } finally {
                process.removeListener('warning', onWarning);
            }
        });

    });
});

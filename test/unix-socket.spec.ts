import { strict as assert } from 'assert';
import { once } from 'events';
import { mkdtemp, rm, stat } from 'fs/promises';
import { get } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { getLocal } from '..';
import { nodeOnly } from './test-utils';

nodeOnly(() => {
    if (process.platform === 'win32') return;

    describe('Unix socket listener', () => {
        let directory: string;
        let socketPath: string;

        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), 'mockttp-unix-'));
            socketPath = join(directory, 'http.sock');
        });

        afterEach(async () => {
            await rm(directory, { recursive: true, force: true });
        });

        it('serves HTTP on a Unix socket and removes the socket on stop', async () => {
            const server = getLocal({ unixSocketPath: socketPath });

            await server.start();
            try {
                assert.throws(() => server.port, /no TCP port/);
                assert.throws(() => server.url, /no TCP port/);
                await server.forGet('/status').thenReply(204);
                const response = await new Promise<number | undefined>((resolve, reject) => {
                    get({ socketPath, path: '/status', headers: { host: 'fixture.test' } }, (response) => {
                        response.resume();
                        response.once('end', () => resolve(response.statusCode));
                    }).once('error', reject);
                });
                assert.equal(response, 204);
            } finally {
                await server.stop();
            }
            await assert.rejects(stat(socketPath), { code: 'ENOENT' });
        });

        it('rejects an occupied socket without removing its owner', async () => {
            const owner = createServer();
            owner.listen(socketPath);
            await once(owner, 'listening');
            try {
                await assert.rejects(getLocal({ unixSocketPath: socketPath }).start(), { code: 'EADDRINUSE' });
                assert((await stat(socketPath)).isSocket());
            } finally {
                await new Promise<void>((resolve, reject) => {
                    owner.close(error => error ? reject(error) : resolve());
                });
            }
        });

        it('rejects a relative path and an explicit TCP port', async () => {
            assert.throws(() => getLocal({ unixSocketPath: 'http.sock' }), /absolute Unix domain socket path/);
            await assert.rejects(getLocal({ unixSocketPath: socketPath }).start(0), /TCP port/);
        });

        it('preserves default TCP startup', async () => {
            const server = getLocal();
            await server.start();
            try {
                assert(server.port > 0);
            } finally {
                await server.stop();
            }
        });
    });
});

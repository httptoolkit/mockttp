import * as https from 'https';
import * as path from 'path';
import { expect, fetch, nodeOnly } from "./test-utils";
import * as fs from '../src/util/fs';
import { CA } from '../src/util/tls';

nodeOnly(() => {
    describe("TLS CA", () => {
        const caKey = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.key'), 'utf8');
        const caCert = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.pem'), 'utf8');

        let server: https.Server;

        it("can generate a certificate for a domain", async () => {
            const ca = new CA(await caKey, await caCert);

            const { cert, key } = ca.generateCertificate('localhost')

            server = https.createServer({ cert, key }, (req: any, res: any) => {
                res.writeHead(200);
                res.end('signed response!');
            });

            await new Promise((resolve) => server.listen(4430, resolve));

            let response = await fetch('https://localhost:4430');
            expect(await response.text()).to.equal('signed response!');
        });

        afterEach((done) => {
            if (server) server.close(done);
        });
    });
});
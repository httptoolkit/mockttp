import * as _ from 'lodash';
import { getLocal } from "../..";
import { expect, nodeOnly } from '../test-utils';

describe("Port selection", function () {

    let server1 = getLocal();
    let server2 = getLocal();

    afterEach(() => Promise.all([
        server1.stop().catch(() => {}),
        server2.stop().catch(() => {})
    ]));

    it("should use a free port starting from 8000 if none is specified", async () => {
        await server1.start();

        expect(server1.port).to.be.gte(8000);
        expect(server1.port).to.be.lt(9000);
    });

    it("should use a fixed port if one is specified", async function () {
        this.retries(3); // Random ports can be in use, esp on Travis, so retry a little

        const chosenPort = 10000 + _.random(1000);
        await server1.start(chosenPort);
        expect(server1.port).to.equal(chosenPort);
    });

    it("should use a port in a range if one is provided", async () => {
        const portRange = { startPort: 10000, endPort: 15000 };

        await server1.start(portRange);
        await server2.start(portRange);

        expect(server1.port).to.be.gte(portRange.startPort);
        expect(server1.port).to.be.lt(portRange.endPort);

        expect(server2.port).to.be.gte(portRange.startPort);
        expect(server2.port).to.be.lt(portRange.endPort);

        expect(server2.port).to.be.gt(server1.port);
    });

    nodeOnly(() => {
        describe("given 100 servers starting in parallel", () => {

            const servers = _.range(0, 100).map(() => getLocal());

            it("finds ports for all servers safely and successfully", async () => {
                await Promise.all(servers.map(s =>
                    // For some reason doing this around the default 8000 range breaks on Travis
                    s.start({ startPort: 12000, endPort: 13000 })
                ));
            });

        });
    });
});
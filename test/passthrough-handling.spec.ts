import { buildOverriddenBody } from "../src/rules/passthrough-handling";
import { expect } from "./test-utils";

describe("Passthrough handling", () => {

    describe("buildOverriddenBody", () => {

        [
            ['false', false],
            ['0', 0],
            ['an empty string', ''],
            ['null', null],
            ['true', true],
            ['an object', { a: 1 }]
        ].forEach(([name, json]) => {
            it(`uses ${name} as a JSON body override`, async () => {
                const headers: { [key: string]: any } = {};
                const body = await buildOverriddenBody({ json } as any, headers);

                expect(body?.toString()).to.equal(JSON.stringify(json));
                expect(headers['content-type']).to.equal('application/json');
            });
        });

        it("returns no override if no body or json is provided", async () => {
            const headers: { [key: string]: any } = {};
            const body = await buildOverriddenBody({}, headers);

            expect(body).to.equal(undefined);
            expect(headers['content-type']).to.equal(undefined);
        });

    });

});

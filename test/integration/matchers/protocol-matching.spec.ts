import { getLocal } from "../../..";
import { expect, fetch } from "../../test-utils";

describe('Protocol matching', () => {
	let server = getLocal({
		https: {
			keyPath: './test/fixtures/test-ca.key',
			certPath: './test/fixtures/test-ca.pem'
		}
	});

	beforeEach(() => server.start());
	afterEach(() => server.stop());

	it("should match requests with the protocol", async () => {
		await server.forGet('/')
			.withProtocol("https")
			.thenReply(200, 'Mocked response');

		let result = await fetch(server.urlFor("/"));

		await expect(result).to.have.responseText('Mocked response');
	});

	it("should reject requests that don't match the protocol", async () => {
		await server.forGet('/')
			.withProtocol("http")
			.thenReply(200, 'Mocked response');

		let result = await fetch(server.urlFor("/"));

		expect(result.status).to.equal(503);
	});
});

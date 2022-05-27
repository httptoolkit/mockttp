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

	it('should throw error when build with invalid protocol', () => {
		const builder = server.forGet("/") as any; // Avoid argument type checking.
		expect(() => builder.withProtocol("HTTP")).throw();
		expect(() => builder.withProtocol("http:")).throw();
		expect(() => builder.withProtocol("somethingelse")).throw();
	});

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

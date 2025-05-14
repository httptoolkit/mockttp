import gql from "graphql-tag";
import { PluggableAdmin, MockttpPluggableAdmin } from "../..";
import { expect, nodeOnly } from "../test-utils";

nodeOnly(() => {
    describe("Admin server plugins", function () {

        let adminServer: PluggableAdmin.AdminServer<{}>;
        let adminClient: PluggableAdmin.AdminClient<{}>;

        afterEach(async () => {
            await adminClient?.stop();
            await adminServer?.stop();
        });

        it("should be able to define additional GraphQL endpoints", async () => {
            adminServer = new PluggableAdmin.AdminServer({
                adminPlugins: {
                    myPlugin: class MyPlugin {
                        start() {}
                        stop() {}
                        schema = "extend type Query { extraQueryEndpoint: Boolean! }"
                        buildResolvers = () => ({ Query: { extraQueryEndpoint: () => true } })
                    }
                }
            });
            await adminServer.start();

            adminClient = new PluggableAdmin.AdminClient();
            await adminClient.start({
                myPlugin: {}
            });

            const result = await adminClient.sendQuery({
                query: gql`
                    query GetTestResult {
                        extraQueryEndpoint
                    }
                `
            } as PluggableAdmin.AdminQuery<{ extraQueryEndpoint: boolean }>);

            expect(result.extraQueryEndpoint).to.equal(true);
        });

        it("should expose the plugin start metadata", async () => {
            adminServer = new PluggableAdmin.AdminServer({
                adminPlugins: {
                    myPlugin: class MyPlugin {
                        start() {
                            return { aMetadataField: true };
                        }
                        stop() {}
                        schema = "extend type Query { endpoint: Boolean! }"
                        buildResolvers = () => ({ Query: { endpoint: () => true } })
                    }
                }
            });
            await adminServer.start();

            let client = adminClient = new PluggableAdmin.AdminClient<{
                myPlugin: PluggableAdmin.AdminPlugin<{}, { aMetadataField: boolean }>
            }>();
            const startResult = await client.start({
                myPlugin: {}
            });

            expect(startResult.myPlugin.aMetadataField).to.equal(true);
            expect(client.metadata.myPlugin.aMetadataField).to.equal(true);

            await client.stop();
            expect(() => client.metadata)
                .to.throw("Metadata is not available");
        });

        it("should be able to use the admin client with a transform callback", async () => {
            adminServer = new PluggableAdmin.AdminServer({
                adminPlugins: {
                    myPlugin: class MyPlugin {
                        start() {}
                        stop() {}
                        schema = "extend type Query { extraQueryEndpoint: Boolean! }"
                        buildResolvers = () => ({ Query: { extraQueryEndpoint: () => true } })
                    }
                }
            });
            await adminServer.start();

            adminClient = new PluggableAdmin.AdminClient();
            await adminClient.start({
                myPlugin: {}
            });

            const result = await adminClient.sendQuery<{ extraQueryEndpoint: boolean }, "good" | "bad">({
                query: gql`
                    query GetTestResult {
                        extraQueryEndpoint
                    }
                `,
                transformResponse: ({ extraQueryEndpoint }) => {
                    if (extraQueryEndpoint) return "good";
                    else return "bad";
                }
            });

            expect(result).to.equal("good");
        });

        it("should be able to combine custom requests with Mockttp requests", async () => {
            adminServer = new PluggableAdmin.AdminServer({
                debug: true,
                adminPlugins: {
                    myPlugin: class MyPlugin {
                        start() {}
                        stop() {}
                        schema = "extend type Query { extraQueryEndpoint: Boolean! }"
                        buildResolvers = () => ({ Query: { extraQueryEndpoint: () => true } })
                    },
                    http: MockttpPluggableAdmin.MockttpAdminPlugin
                }
            });
            await adminServer.start();

            const client = adminClient = new PluggableAdmin.AdminClient();
            await adminClient.start({
                myPlugin: {},
                http: {}
            });

            const mockttpAdminRequestBuilder = new MockttpPluggableAdmin.MockttpAdminRequestBuilder(
                client.schema,
                { messageBodyDecoding: "server-side" }
            );

            const [myPluginResult, mockttpEndpointsResult] = await adminClient.sendQueries(
                {
                    query: gql`
                        query MyQuery {
                            extraQueryEndpoint
                        }
                    `,
                    transformResponse: ({ extraQueryEndpoint }) => {
                        if (extraQueryEndpoint) return "good";
                        else return "bad";
                    }
                },
                mockttpAdminRequestBuilder.buildPendingEndpointsQuery()
            );

            expect(myPluginResult).to.equal("good");
            expect(mockttpEndpointsResult).to.deep.equal([]);
        });

        it("should be verbose debuggable", async () => {
            adminServer = new PluggableAdmin.AdminServer({
                adminPlugins: {
                    myPlugin: class MyPlugin {
                        start() {}
                        stop() {}

                        debug = false;
                        enableDebug() { this.debug = true; }

                        schema = "extend type Query { isDebuggable: Boolean! }"
                        buildResolvers = () => ({
                            Query: {
                                isDebuggable: () => this.debug
                            }
                        })
                    }
                }
            });
            await adminServer.start();

            adminClient = new PluggableAdmin.AdminClient();
            await adminClient.start({
                myPlugin: {}
            });

            const debuggableQuery = {
                query: gql`
                    query GetTestResult {
                        isDebuggable
                    }
                `,
                transformResponse: ({ isDebuggable }) => isDebuggable,
            } as PluggableAdmin.AdminQuery<{ isDebuggable: boolean }, boolean>;

            expect(await adminClient.sendQuery(debuggableQuery)).to.equal(false);
            await adminClient.enableDebug();
            expect(await adminClient.sendQuery(debuggableQuery)).to.equal(true);
        });
    });
});
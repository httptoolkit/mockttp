import _ = require('lodash');

import { MockedEndpoint } from "../types";
import { Mockttp, AbstractMockttp, MockttpOptions, PortRange, SubscribableEvent } from "../mockttp";

import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from '../rules/websockets/websocket-rule';

import { serializeRuleData } from '../rules/rule-serialization';
import { AdminClient } from './admin-client';
import { MockttpAdminPlugin } from '../admin/mockttp-admin-plugin';
import { MockttpAdminRequestBuilder } from './mockttp-admin-request-builder';

export interface MockttpClientOptions extends MockttpOptions {
    /**
     * The full URL to use to connect to a Mockttp admin server when using a
     * remote (or local but browser) client.
     *
     * When using a local server, this option is ignored.
     */
    adminServerUrl?: string;

    /**
     * @deprecated Alias for adminServerUrl option
     */
    standaloneServerUrl?: string;

    /**
     * Options to include on all client requests, e.g. to add extra
     * headers for authentication.
     */
    client?: {
        headers?: { [key: string]: string };
    }
}

/**
 * A Mockttp implementation, controlling a remote Mockttp admin server.
 *
 * A MockttpClient supports the exact same Mockttp API as MockttpServer, but rather
 * than directly using Node.js APIs to start a mock server and rewrite traffic, it
 * makes calls to a remote admin server to start a mock server and rewrite traffic
 * there. This is useful to allow proxy configuration from inside browser tests, and
 * to allow creating mock proxies that run on remote machines.
 */
export class MockttpClient extends AbstractMockttp implements Mockttp {

    private mockServerOptions: MockttpOptions;

    private adminClient: AdminClient<{ http: MockttpAdminPlugin }>;
    private requestBuilder: MockttpAdminRequestBuilder | undefined; // Set once server has started.

    constructor(options: MockttpClientOptions = {}) {
        super(_.defaults(options, {
            // Browser clients generally want cors enabled. For other clients, it doesn't hurt.
            // TODO: Maybe detect whether we're in a browser in future
            cors: true,
        }));

        this.mockServerOptions = options;

        this.adminClient = new AdminClient({
            adminServerUrl: options.adminServerUrl || options.standaloneServerUrl,
            requestOptions: options.client
        });
    }

    enableDebug(): Promise<void> {
        return this.adminClient.enableDebug();
    }

    reset = (): Promise<void> => {
        return this.adminClient.reset();
    }

    get url(): string {
        return this.adminClient.metadata!.http.mockRoot;
    }

    get port(): number {
        return this.adminClient.metadata!.http.port;
    }

    async start(port?: number | PortRange) {
        await this.adminClient.start({
            http: {
                port,
                options: this.mockServerOptions
            }
        });

        this.requestBuilder = new MockttpAdminRequestBuilder(this.adminClient.schema);
    }

    stop() {
        return this.adminClient.stop();
    }

    public addRequestRules = async (...rules: RequestRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRequestRules(rules, false);
    }

    public setRequestRules = async (...rules: RequestRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRequestRules(rules, true);
    }

    public addWebSocketRules = async (...rules: WebSocketRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addWsRules(rules, false);
    }

    public setWebSocketRules = async (...rules: WebSocketRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addWsRules(rules, true);
    }

    private _addRequestRules = async (
        rules: Array<RequestRuleData>,
        reset: boolean
    ): Promise<MockedEndpoint[]> => {
        if (!this.requestBuilder) throw new Error('Cannot add rules before the server is started');

        const { schema, adminStream } = this.adminClient;

        const serializedRules = rules.map((rule) => {
            const serializedRule = serializeRuleData(rule, adminStream)
            if (!schema.typeHasInputField('MockRule', 'id')) {
                delete serializedRule.id;
            }
            return serializedRule;
        });

        return this.adminClient.sendQuery(
            this.requestBuilder.buildAddRequestRulesQuery(serializedRules, reset)
        );
    }

    setFallbackRequestRule = async (
        rule: RequestRuleData
    ): Promise<MockedEndpoint> => {
        if (!this.requestBuilder) throw new Error('Cannot add rules before the server is started');

        const { adminStream } = this.adminClient;
        return this.adminClient.sendQuery(
            this.requestBuilder.buildSetFallbackRequestRuleQuery(serializeRuleData(rule, adminStream))
        );
    }

    private _addWsRules = async (
        rules: Array<WebSocketRuleData>,
        reset: boolean
    ): Promise<MockedEndpoint[]> => {
        if (!this.requestBuilder) throw new Error('Cannot add rules before the server is started');

        const { adminStream } = this.adminClient;

        return this.adminClient.sendQuery(
            this.requestBuilder.buildAddWebSocketRulesQuery(
                rules.map((rule) => serializeRuleData(rule, adminStream)),
                reset
            )
        );
    }

    public async getMockedEndpoints() {
        if (!this.requestBuilder) throw new Error('Cannot query mocked endpoints before the server is started');

        return this.adminClient.sendQuery(
            this.requestBuilder.buildMockedEndpointsQuery()
        );
    }

    public async getPendingEndpoints() {
        if (!this.requestBuilder) throw new Error('Cannot query pending endpoints before the server is started');

        return this.adminClient.sendQuery(
            this.requestBuilder.buildPendingEndpointsQuery()
        );
    }

    public async getRuleParameterKeys() {
        return this.adminClient.getRuleParameterKeys();
    }

    public on(event: SubscribableEvent, callback: (data: any) => void): Promise<void> {
        if (!this.requestBuilder) throw new Error('Cannot subscribe to events before the server is started');

        return this.adminClient.subscribe(
            this.requestBuilder.buildSubscriptionRequest(event),
            callback
        );
    }
}
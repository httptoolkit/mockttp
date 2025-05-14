import _ = require('lodash');

import { MockedEndpoint } from "../types";
import { Mockttp, AbstractMockttp, MockttpOptions, PortRange, SubscribableEvent } from "../mockttp";

import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from '../rules/websockets/websocket-rule';

import { AdminClient, AdminClientEvent } from './admin-client';
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
     * Options to include on all client requests, e.g. to add extra
     * headers for authentication.
     */
    client?: {
        headers?: { [key: string]: string };
    }

    /**
     * Where should message body decoding happen? If set to 'server-side',
     * (the default) then the request body will be pre-decoded on the server,
     * and delivered to the client in decoded form (in addition to its
     * encoded form), meaning that the client doesn't need to do any
     * decoding itself (which can be awkward e.g. given encodings like
     * zstd/Brotli with poor browser JS support).
     *
     * If set to 'none', the request body will be delivered to
     * the client in original encoded form. If so, any access to data
     * that requires decoding (e.g. `response.body.getText()` on a
     * gzipped response) will fail. Instead, you will need to read and
     * decode `body.buffer` manually yourself.
     *
     * This is only relevant for advanced use cases. In general, you
     * should leave this as 'server-side' for convenient reliable
     * behaviour, and set it only to 'none' if you are handling
     * decoding yourself and want to actively optimize for that.
     */
    messageBodyDecoding?: 'server-side' | 'none';
}

export type MockttpClientEvent = `admin-client:${AdminClientEvent}`;

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
    private messageBodyDecoding: 'server-side' | 'none';

    private adminClient: AdminClient<{ http: MockttpAdminPlugin }>;
    private requestBuilder: MockttpAdminRequestBuilder | undefined; // Set once server has started.

    constructor(options: MockttpClientOptions = {}) {
        super(_.defaults(options, {
            // Browser clients generally want cors enabled. For other clients, it doesn't hurt.
            // TODO: Maybe detect whether we're in a browser in future
            cors: true,
        }));

        this.mockServerOptions = options;
        this.messageBodyDecoding = options.messageBodyDecoding || 'server-side';

        this.adminClient = new AdminClient({
            adminServerUrl: options.adminServerUrl,
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
                messageBodyDecoding: this.messageBodyDecoding,
                options: this.mockServerOptions,
            }
        });

        this.requestBuilder = new MockttpAdminRequestBuilder(
            this.adminClient.schema,
            { messageBodyDecoding: this.messageBodyDecoding }
        );
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

        const { adminStream } = this.adminClient;
        return this.adminClient.sendQuery(
            this.requestBuilder.buildAddRequestRulesQuery(rules, reset, adminStream)
        );
    }

    private _addWsRules = async (
        rules: Array<WebSocketRuleData>,
        reset: boolean
    ): Promise<MockedEndpoint[]> => {
        if (!this.requestBuilder) throw new Error('Cannot add rules before the server is started');

        const { adminStream } = this.adminClient;

        return this.adminClient.sendQuery(
            this.requestBuilder.buildAddWebSocketRulesQuery(rules, reset, adminStream)
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

    public on(event: SubscribableEvent | MockttpClientEvent, callback: (data: any) => void): Promise<void> {
        if (event.startsWith('admin-client:')) {
            // All MockttpClient events come from the internal admin-client instance:
            this.adminClient.on(event.slice('admin-client:'.length), callback);
            return Promise.resolve();
        }

        if (!this.requestBuilder) throw new Error('Cannot subscribe to Mockttp events before the server is started');

        const subRequest = this.requestBuilder.buildSubscriptionRequest(event as SubscribableEvent);

        if (!subRequest) {
            // We just return an immediately promise if we don't recognize the event, which will quietly
            // succeed but never call the corresponding callback (the same as the server and most event
            // sources in the same kind of situation). This is what happens when the *client* doesn't
            // recognize the event. Subscribe() below handles the unknown-to-server case.
            console.warn(`Ignoring subscription for event unrecognized by Mockttp client: ${event}`);
            return Promise.resolve();
        }

        return this.adminClient.subscribe(subRequest, callback);
    }
}
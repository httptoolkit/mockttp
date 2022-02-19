import * as _ from 'lodash';
import { Duplex } from 'stream';

import type { AdminPlugin } from './admin-plugin-types';

import { MockttpOptions, PortRange } from "../mockttp";
import { MockttpServer } from "../server/mockttp-server";
import { buildAdminServerModel } from "./mockttp-admin-model";
import { MockttpSchema } from './mockttp-schema';

export interface MockttpPluginOptions {
    serverOptions?: Partial<MockttpOptions>;
    port?: number | PortRange;
}

export interface MockttpClientResponse {
    port: number,
    mockRoot: string
}

export const buildMockttpAdminPlugin = (serverDefaults: MockttpOptions = {})=> {
    return MockttpAdminPlugin.bind(null, serverDefaults);
}

class MockttpAdminPlugin implements AdminPlugin<
    MockttpPluginOptions,
    MockttpClientResponse
> {

    constructor(
        private serverDefaults: MockttpOptions = {}
    ) {}

    private mockServer!: MockttpServer;

    async start(options: MockttpPluginOptions) {
        const mockServerOptions: MockttpOptions = _.defaults(
            {},
            options.serverOptions,
            this.serverDefaults
        );

        this.mockServer = new MockttpServer(mockServerOptions);

        await this.mockServer.start(options.port);

        return {
            port: this.mockServer.port,
            mockRoot: this.mockServer.url
        };
    }

    stop() {
        return this.mockServer.stop();
    }

    reset() {
        return this.mockServer.reset();
    }

    getMockServer() {
        return this.mockServer;
    }

    schema = MockttpSchema;

    buildResolvers(stream: Duplex, ruleParameters: { [key: string]: any }) {
        return buildAdminServerModel(this.mockServer, stream, ruleParameters)
    };
}

export type { MockttpAdminPlugin };
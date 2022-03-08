import * as _ from 'lodash';
import { Duplex } from 'stream';

import type { AdminPlugin } from './admin-plugin-types';

import { MockttpOptions, PortRange } from "../mockttp";
import { MockttpServer } from "../server/mockttp-server";
import { buildAdminServerModel } from "./mockttp-admin-model";
import { MockttpSchema } from './mockttp-schema';

export interface MockttpPluginOptions {
    options?: Partial<MockttpOptions>;
    port?: number | PortRange;
}

export interface MockttpClientResponse {
    port: number,
    mockRoot: string
}

export class MockttpAdminPlugin implements AdminPlugin<
    MockttpPluginOptions,
    MockttpClientResponse
> {

    private mockServer!: MockttpServer;

    async start({ port, options }: MockttpPluginOptions) {
        this.mockServer = new MockttpServer(options);
        await this.mockServer.start(port);

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

    enableDebug() {
        this.mockServer.enableDebug();
    }

    schema = MockttpSchema;

    buildResolvers(stream: Duplex, ruleParameters: { [key: string]: any }) {
        return buildAdminServerModel(this.mockServer, stream, ruleParameters)
    };
}
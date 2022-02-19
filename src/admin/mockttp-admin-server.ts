import { AdminServer, AdminServerOptions } from "./admin-server";

import { MockttpOptions } from "../mockttp";
import { buildMockttpAdminPlugin, MockttpAdminPlugin } from "./mockttp-admin-plugin";

export interface MockttpAdminServerOptions extends Omit<AdminServerOptions<{}>, 'adminPlugins'> {
    /**
     * Override the default parameters for servers started from this admin server. These values will be
     * used for each setting that is not explicitly specified by the client when creating a mock server.
     */
    serverDefaults?: MockttpOptions;
}

export class MockttpAdminServer extends AdminServer<{ http: MockttpAdminPlugin }> {

    constructor(options: MockttpAdminServerOptions) {
        super({
            ...options,
            adminPlugins: { http: buildMockttpAdminPlugin(options.serverDefaults) }
        });
    }

}
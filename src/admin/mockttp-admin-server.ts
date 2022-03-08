import * as _ from 'lodash';
import { AdminServer, AdminServerOptions } from "./admin-server";

import { MockttpOptions } from "../mockttp";
import { MockttpAdminPlugin } from "./mockttp-admin-plugin";

export interface MockttpAdminServerOptions extends Omit<AdminServerOptions<{}>,
    'adminPlugins' | 'pluginDefaults'
> {
    /**
     * Override the default parameters for servers started from this admin server. These values will be
     * used for each setting that is not explicitly specified by the client when creating a mock server.
     */
    serverDefaults?: MockttpOptions;
}

export class MockttpAdminServer extends AdminServer<{ http: MockttpAdminPlugin }> {

    constructor(options: MockttpAdminServerOptions) {
        super({
            ..._.omit(options, 'serverDefaults'),
            pluginDefaults: { http: { options: options.serverDefaults } },
            adminPlugins: { http: MockttpAdminPlugin }
        });
    }

}
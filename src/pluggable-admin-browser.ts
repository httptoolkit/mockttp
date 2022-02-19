export type {
    AdminPlugin
} from "./admin/admin-plugin-types";

export class AdminServer {
    constructor() {
        throw new Error("AdminServer cannot be used within a browser");
    }
}

export class MockttpAdminPlugin {
    constructor() {
        throw new Error("MockttpAdminPlugin cannot be used within a browser");
    }
}

export { AdminClient } from "./client/admin-client";
export { MockttpAdminRequestBuilder } from "./client/mockttp-admin-request-builder";
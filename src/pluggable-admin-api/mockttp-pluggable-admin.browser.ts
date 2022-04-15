export class MockttpAdminPlugin {
    constructor() {
        throw new Error("MockttpAdminPlugin cannot be used within a browser");
    }
}

export { MockttpAdminRequestBuilder } from "../client/mockttp-admin-request-builder";
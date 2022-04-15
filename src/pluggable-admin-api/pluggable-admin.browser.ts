export class AdminServer {
    constructor() {
        throw new Error("AdminServer cannot be used within a browser");
    }
}

export { AdminClient } from "../client/admin-client";
/**
 * @module Internal
 */

import { MockedEndpointData, MockedEndpoint, CompletedRequest } from "../types";

export class MockedEndpointClient implements MockedEndpoint {

    public constructor(
        public readonly id: string,
        private getMockedEndpointData: () => Promise<MockedEndpointData | null>
    ) { }

    public async getSeenRequests(): Promise<CompletedRequest[]> {
        const mockedEndpointData = await this.getMockedEndpointData();
        if (mockedEndpointData === null) throw new Error("Can't get seen requests for unknown mocked endpoint");

        return mockedEndpointData.seenRequests;
    }
}
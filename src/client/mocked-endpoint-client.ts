import { MockedEndpointData, MockedEndpoint, CompletedRequest } from "../types";

export class MockedEndpointClient implements MockedEndpoint {

    public constructor(
        public readonly id: string,
        private explanation: string | undefined,
        private endpointDataGetter: () => Promise<MockedEndpointData | null>
    ) { }

    private async getMockedEndpointData() {
        const mockedEndpointData = await this.endpointDataGetter();
        if (mockedEndpointData === null) throw new Error("Can't get seen requests for unknown mocked endpoint");
        else return mockedEndpointData;
    }

    public async getSeenRequests(): Promise<CompletedRequest[]> {
        return (await this.getMockedEndpointData()).seenRequests;
    }

    public async isPending(): Promise<boolean> {
        return (await this.getMockedEndpointData()).isPending;
    }

    toString() {
        if (this.explanation) {
            return "Mocked endpoint: " + this.explanation;
        } else {
            return Object.toString.call(this);
        }
    }
}
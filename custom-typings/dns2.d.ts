declare module 'dns2' {
    import * as net from 'net';

    interface DnsRequest {
        header: { id: string };
        questions: DnsQuestion[];
    }

    interface DnsQuestion {
        name: string;
    }

    interface DnsResponse {
        answers: DnsAnswer[];
    }

    interface DnsAnswer {
        name: string;
        type: number;
        class: number;
        ttl: number;
        address: string;
    }

    export function createServer(callback: (
        request: DnsRequest,
        send: (response: DnsResponse) => void,
        rinfo: unknown
    ) => void): net.Server;

    export namespace Packet {
        export const TYPE: {
            A: number;
        };

        export const CLASS: {
            IN: number;
        };

        export function createResponseFromRequest(request: DnsRequest): DnsResponse;
    }
}
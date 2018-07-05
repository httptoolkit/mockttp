declare module 'duplex-passthrough' {
    import { Duplex, PassThrough } from "stream";

    class DuplexPassThrough extends Duplex {
        constructor(stream?: Duplex | null, options?: { objectMode?: boolean });

        wrapStream(stream: Duplex): void;

        _reader: Duplex;
        _writer: Duplex;
    }

    export = DuplexPassThrough;
}
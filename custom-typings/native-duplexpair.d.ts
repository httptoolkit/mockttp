declare module 'native-duplexpair' {
    import { Duplex } from 'stream';

    class DuplexPair {
        public readonly socket1: Duplex;
        public readonly socket2: Duplex;

        constructor(options?: { objectMode?: boolean });
    }

    export = DuplexPair;
}
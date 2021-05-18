declare module 'zstd-codec' {
    export namespace ZstdCodec {
        export function run(callback: (zstd: ZstdBinding) => void): void;
    }

    interface ZstdBinding {
        Simple: typeof ZstdSimple;
        Streaming: typeof ZstdStreaming;
    }

    class ZstdSimple {
        compress(contentBytes: Uint8Array, compressionLevel?: number): Uint8Array;
        decompress(contentBytes: Uint8Array): Uint8Array;
    }

    class ZstdStreaming {
        compress(contentBytes: Uint8Array, compressionLevel?: number): Uint8Array;
        decompress(compressedBytes: Uint8Array, sizeHint?: number): Uint8Array;
    }
}
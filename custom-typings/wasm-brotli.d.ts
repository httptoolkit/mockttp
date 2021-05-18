declare module 'wasm-brotli' {
    export function compress(buffer: Uint8Array): Promise<Uint8Array>;
    export function decompress(buffer: Uint8Array): Promise<Uint8Array>;
}
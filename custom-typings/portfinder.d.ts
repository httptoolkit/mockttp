declare module "portfinder" {
    export function getPort(callback: (err: any, port: number) => void): void;
}

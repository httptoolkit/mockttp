export enum Method {
    GET,
    POST,
    PUT
}

export interface Explainable {
    explain(): string;
}

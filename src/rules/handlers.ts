import express = require("express");
import { Request } from "../types";
import { RequestHandler } from "./mock-rule-types";

export type HandlerData = (
    SimpleHandlerData
);

export type HandlerType = HandlerData['type'];

export type HandlerDataLookup = {
    'simple': SimpleHandlerData,
}

export class SimpleHandlerData {
    readonly type = 'simple';

    constructor(
        public status: number,
        public data?: string
    ) {}
}

type HandlerBuilder<D extends HandlerData> = (data: D) => RequestHandler;

export function buildHandler
    <T extends HandlerType, D extends HandlerDataLookup[T]>
    (handlerData: D): RequestHandler
{
    // Neither of these casts should really be required imo, seem like TS bugs
    const type = <T> handlerData.type;
    const builder = <HandlerBuilder<D>> handlerBuilders[type];
    return builder(handlerData);
}

const handlerBuilders: { [T in HandlerType]: HandlerBuilder<HandlerDataLookup[T]> } = {
    simple: ({ data, status }: SimpleHandlerData): RequestHandler => {
        let responder = <RequestHandler> async function(request: Request, response: express.Response) {
            response.writeHead(status);
            response.end(data || "");
        }
        responder.explain = () => `respond with status ${status}` + (data ? ` and body "${data}"` : "");
        return responder;
    }
};
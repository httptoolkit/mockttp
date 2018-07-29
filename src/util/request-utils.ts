/**
 * @module Internal
 */

import * as _ from 'lodash';
import { OngoingRequest, CompletedRequest, CompletedResponse, OngoingResponse } from "../types";

export async function waitForCompletedRequest(request: OngoingRequest): Promise<CompletedRequest> {
    return _(request).pick([
        'protocol',
        'method',
        'url',
        'path',
        'hostname',
        'headers'
    ]).assign({
        body: {
            buffer: await request.body.asBuffer(),
            text: await request.body.asText().catch(() => undefined),
            json: await request.body.asJson().catch(() => undefined),
            formData: await request.body.asFormData().catch(() => undefined)
        }
    }).valueOf();
}

export interface TrackedOngoingResponse extends OngoingResponse {
    getHeaders(): { [key: string]: string };
}

export function trackResponse(response: OngoingResponse): TrackedOngoingResponse {
    let trackedResponse = <TrackedOngoingResponse> response;
    if (!trackedResponse.getHeaders) {
        // getHeaders was added in 7.7. - if it's not available, polyfill it
        trackedResponse.getHeaders = function (this: any) { return this._headers; }
    }

    return trackedResponse;
}

export async function waitForCompletedResponse(response: TrackedOngoingResponse): Promise<CompletedResponse> {
    return _(response).pick([
        'statusCode',
        'statusMessage'
    ]).assign({
        headers: response.getHeaders(),
        body: {
            buffer: new Buffer(0),
            text: undefined,
            json: undefined,
            formData: undefined
        }
    }).valueOf();
}
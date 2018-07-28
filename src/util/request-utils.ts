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

export async function waitForCompletedResponse(response: OngoingResponse): Promise<CompletedResponse> {
    return _(response).pick([
        'statusCode',
        'statusMessage'
    ]).assign({
        headers: { },
        body: {
            buffer: new Buffer(0),
            text: undefined,
            json: undefined,
            formData: undefined
        }
    }).valueOf();
}
import { Duplex } from "stream";

import { Serialized, deserialize } from "../serialization/serialization";

import type { RequestRuleData } from "./requests/request-rule";
import type { WebSocketRuleData } from "./websockets/websocket-rule";

import * as matchers from "./matchers";
import * as completionCheckers from "./completion-checkers";

import { HandlerLookup } from "./requests/request-handlers";
import { WsHandlerLookup } from './websockets/websocket-handlers';

import { RuleParameters } from "./rule-parameters";
import { BodySerializer } from "../serialization/body-serialization";

/**
 * @internal
 */
export interface MockttpDeserializationOptions {
    ruleParams: RuleParameters;
    bodySerializer: BodySerializer;
}

export function deserializeRuleData(
    data: Serialized<RequestRuleData>,
    stream: Duplex,
    options: MockttpDeserializationOptions
): RequestRuleData {
    return {
        id: data.id,
        priority: data.priority,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, options, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, options, HandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            options,
            completionCheckers.CompletionCheckerLookup
        )
    };
}

export function deserializeWebSocketRuleData(
    data: Serialized<WebSocketRuleData>,
    stream: Duplex,
    options: MockttpDeserializationOptions
): WebSocketRuleData {
    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, options, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, options, WsHandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            options,
            completionCheckers.CompletionCheckerLookup
        )
    };
}
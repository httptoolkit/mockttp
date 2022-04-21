import { Duplex } from "stream";

import { Serialized, deserialize } from "../serialization/serialization";

import type { RuleParameters } from "./rule-parameters";

import type { RequestRuleData } from "./requests/request-rule";
import type { WebSocketRuleData } from "./websockets/websocket-rule";

import * as matchers from "./matchers";
import * as completionCheckers from "./completion-checkers";

import { HandlerLookup } from "./requests/request-handlers";
import { WsHandlerLookup } from './websockets/websocket-handlers';

export function deserializeRuleData(
    data: Serialized<RequestRuleData>,
    stream: Duplex,
    ruleParameters: RuleParameters
): RequestRuleData {
    return {
        id: data.id,
        priority: data.priority,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, ruleParameters, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, ruleParameters, HandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            ruleParameters,
            completionCheckers.CompletionCheckerLookup
        )
    };
}

export function deserializeWebSocketRuleData(
    data: Serialized<WebSocketRuleData>,
    stream: Duplex,
    ruleParameters: RuleParameters
): WebSocketRuleData {
    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, ruleParameters, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, ruleParameters, WsHandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            ruleParameters,
            completionCheckers.CompletionCheckerLookup
        )
    };
}
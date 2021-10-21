import { Duplex } from "stream";

import { Serialized, serialize, deserialize } from "../util/serialization";

import { RuleParameters } from "./rule-parameters";

import { RequestRuleData } from "./requests/request-rule";
import { WebSocketRuleData } from "./websockets/websocket-rule";

import * as matchers from "./matchers";
import * as completionCheckers from "./completion-checkers";

import { HandlerLookup } from "./requests/request-handlers";
import { WsHandlerLookup } from './websockets/websocket-handlers';

export function validateMockRuleData(data: RequestRuleData | WebSocketRuleData): void {
    if (!data.matchers || data.matchers.length === 0) {
        throw new Error('Cannot create a rule without at least one matcher');
    }
    if (!data.handler) {
        throw new Error('Cannot create a rule with no handler');
    }
}

export function serializeRuleData<
    DataFormat extends RequestRuleData | WebSocketRuleData
>(data: DataFormat, stream: Duplex): Serialized<DataFormat> {
    validateMockRuleData(data);

    return {
        id: data.id,
        matchers: data.matchers.map(m => serialize(m, stream)),
        handler: serialize(data.handler, stream),
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    } as Serialized<DataFormat>;
};

export function deserializeRuleData(
    data: Serialized<RequestRuleData>,
    stream: Duplex,
    ruleParameters: RuleParameters
): RequestRuleData {
    return {
        id: data.id,
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
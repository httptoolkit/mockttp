import { Duplex } from "stream";

import { Serialized, SerializedValue, deserialize } from "../serialization/serialization";

import type { RequestRuleData } from "./requests/request-rule";
import type { WebSocketRuleData } from "./websockets/websocket-rule";
import type { RequestStepDefinition } from "./requests/request-step-definitions";
import type { WebSocketStepDefinition } from "./websockets/websocket-step-definitions";

import * as matchers from "./matchers";
import * as completionCheckers from "./completion-checkers";

import { StepLookup } from "./requests/request-step-impls";
import { WsStepLookup } from './websockets/websocket-step-impls';

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
    data: Serialized<RequestRuleData> &
        // API backward compat, only used if steps is missing:
        { handler?: SerializedValue<RequestStepDefinition> },
    stream: Duplex,
    options: MockttpDeserializationOptions
): RequestRuleData {
    const steps = data.steps
            ? data.steps
        : data.handler
            ? [data.handler]
        : [];

    return {
        id: data.id,
        priority: data.priority,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, options, matchers.MatcherLookup)
        ),
        steps: steps.map(step => deserialize(step, stream, options, StepLookup)),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            options,
            completionCheckers.CompletionCheckerLookup
        )
    };
}

export function deserializeWebSocketRuleData(
    data: Serialized<WebSocketRuleData> &
        // API backward compat, only used if steps is missing:
        { handler?: SerializedValue<WebSocketStepDefinition> },
    stream: Duplex,
    options: MockttpDeserializationOptions
): WebSocketRuleData {
    const steps = data.steps
            ? data.steps
        : data.handler
            ? [data.handler]
        : [];

    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, options, matchers.MatcherLookup)
        ),
        steps: steps.map(step => deserialize(step, stream, options, WsStepLookup)),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            options,
            completionCheckers.CompletionCheckerLookup
        )
    };
}


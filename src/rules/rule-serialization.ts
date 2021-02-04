import { Duplex } from "stream";

import { Serialized, serialize, deserialize } from "../util/serialization";

import { MockRuleData } from "./mock-rule";
import { MockWsRuleData } from "./websockets/mock-ws-rule";

import * as matchers from "./matchers";
import * as completionCheckers from "./completion-checkers";

import { HandlerLookup } from "./handlers";
import { WsHandlerLookup } from './websockets/ws-handlers';

export function validateMockRuleData(data: MockRuleData | MockWsRuleData): void {
    if (!data.matchers || data.matchers.length === 0) {
        throw new Error('Cannot create a rule without at least one matcher');
    }
    if (!data.handler) {
        throw new Error('Cannot create a rule with no handler');
    }
}

export function serializeRuleData<
    DataFormat extends MockRuleData | MockWsRuleData
>(data: DataFormat, stream: Duplex): Serialized<DataFormat> {
    validateMockRuleData(data);

    return {
        id: data.id,
        matchers: data.matchers.map(m => serialize(m, stream)),
        handler: serialize(data.handler, stream),
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    } as Serialized<DataFormat>;
};

export function deserializeRuleData(data: Serialized<MockRuleData>, stream: Duplex): MockRuleData {
    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, HandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            completionCheckers.CompletionCheckerLookup
        )
    };
}

export function deserializeWsRuleData(data: Serialized<MockWsRuleData>, stream: Duplex): MockWsRuleData {
    return {
        id: data.id,
        matchers: data.matchers.map((m) =>
            deserialize(m, stream, matchers.MatcherLookup)
        ),
        handler: deserialize(data.handler, stream, WsHandlerLookup),
        completionChecker: data.completionChecker && deserialize(
            data.completionChecker,
            stream,
            completionCheckers.CompletionCheckerLookup
        )
    };
}
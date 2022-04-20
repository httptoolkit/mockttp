import { Duplex } from "stream";

import { Serialized, serialize } from "../serialization/serialization";

import type { RequestRuleData } from "./requests/request-rule";
import type { WebSocketRuleData } from "./websockets/websocket-rule";

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
        priority: data.priority,
        matchers: data.matchers.map(m => serialize(m, stream)),
        handler: serialize(data.handler, stream),
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    } as Serialized<DataFormat>;
};
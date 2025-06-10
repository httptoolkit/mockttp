import { Duplex } from "stream";

import { Serialized, serialize } from "../serialization/serialization";

import type { RequestRuleData } from "./requests/request-rule";
import type { WebSocketRuleData } from "./websockets/websocket-rule";

export function validateMockRuleData(data: RequestRuleData | WebSocketRuleData): void {
    if (!data.matchers || data.matchers.length === 0) {
        throw new Error('Cannot create a rule without at least one matcher');
    }
    if (!data.steps || data.steps.length === 0) {
        throw new Error('Cannot create a rule with no steps');
    }
}

export function serializeRuleData<
    DataFormat extends RequestRuleData | WebSocketRuleData
>(
    data: DataFormat,
    stream: Duplex,
    options: { supportsSteps: boolean }
): Serialized<DataFormat> {
    validateMockRuleData(data);

    // Backward compat to fall back to single-step 'handler' API for old servers
    // as long as the rule is just a single step (or fail loudly if not)
    const stepsOrHandler = options.supportsSteps
            ? {
                steps: data.steps.map(step => serialize(step, stream))
            }
        : data.steps.length === 1
            ? {
                handler: serialize(data.steps[0], stream)
            }
        : (() => {
            throw new Error("Multi-step rules are not supported by the remote Mockttp server")
        })();

    return {
        id: data.id,
        priority: data.priority,
        matchers: data.matchers.map(m => serialize(m, stream)),
        ...stepsOrHandler,
        completionChecker: data.completionChecker && serialize(data.completionChecker, stream)
    } as Serialized<DataFormat>;
};


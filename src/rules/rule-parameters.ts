export type RuleParameters = {
    [key: string]: unknown;
};

export const MOCKTTP_PARAM_REF = Symbol('MOCKTTP_PARAM_REF');

/**
 * A reference to a rule parameter defined in the `ruleParameters` admin server
 * option of the corresponding admin server.
 *
 * Rule parameter references are only valid with a remote client. They can be useful in
 * cases where the admin server has access to local state or APIs that are not
 * accessible from the remote client, but which would be  useful in rule definitions. This
 * is only supported for some specific parameters where documented explicitly in that rule
 * parameter.
 */
export type RuleParameterReference<R> = {
    [MOCKTTP_PARAM_REF]: string
};

export function isParamReference(input: any): input is RuleParameterReference<unknown> {
    return input && !!input[MOCKTTP_PARAM_REF];
};

export function dereferenceParam<R>(paramRef: RuleParameterReference<R>, params: RuleParameters): R {
    const paramKey = paramRef[MOCKTTP_PARAM_REF];
    if (paramKey in params) {
        return params[paramKey] as R;
    } else {
        throw new Error(`Invalid reference to undefined rule parameter '${paramKey}'`);
    }
};

export function assertParamDereferenced<R>(maybeParamRef: R | RuleParameterReference<R>): R {
    if (isParamReference(maybeParamRef)) {
        const paramKey = maybeParamRef[MOCKTTP_PARAM_REF];
        throw new Error(`Non-dereferenced rule parameter used unexpectedly: ${paramKey}`);
    } else {
        return maybeParamRef;
    }
}
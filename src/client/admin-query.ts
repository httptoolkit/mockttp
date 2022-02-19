import {
    DocumentNode,
    FieldNode,
    SelectionNode,
    SelectionSetNode
} from "graphql";

import { MaybePromise } from "../util/type-utils";

import type { AdminClient } from "./admin-client";

export interface QueryContext {
    adminClient: AdminClient<{}>;
}

export interface AdminQuery<Response extends unknown, Result extends unknown = Response> {
    query: DocumentNode;
    variables?: {};
    transformResponse?: (result: Response, context: QueryContext) => MaybePromise<Result>;
}

function isFieldSelection(selection: SelectionNode): selection is FieldNode {
    return selection.kind === 'Field';
}

function getQuerySelectionNode(gqlQuery: DocumentNode): SelectionSetNode {
    const { definitions } = gqlQuery;
    if (definitions.length !== 1 || definitions[0].kind !== 'OperationDefinition') {
        throw new Error("Admin queries must be defined as a single operation definition");
    }

    return definitions[0].selectionSet;
}

// Enforces that the query selects only one field (this is relevant for subscriptions),
// and extracts and returns the name of that field.
export function getSingleSelectedFieldName(query: AdminQuery<any, any>): string {
    const selectedFieldNames = getQuerySelectionNode(query.query)
        .selections
        .filter(isFieldSelection)
        .map(selection => selection.name.value);

    if (selectedFieldNames.length !== 1) {
        throw new Error(
            `This admin query must select only one field, but it selects ${
                selectedFieldNames.length
            }: ${selectedFieldNames.join(', ')}`
        );
    }

    return selectedFieldNames[0];
}
import * as _ from 'lodash';
import { Kind, ObjectValueNode, ValueNode } from "graphql";

export function astToObject<T>(ast: ObjectValueNode): T {
    return <T> _.zipObject(
        ast.fields.map((f) => f.name.value),
        ast.fields.map((f) => parseAnyAst(f.value))
    );
}

export function parseAnyAst(ast: ValueNode): any {
    switch (ast.kind) {
        case Kind.OBJECT:
            return astToObject<any>(ast);
        case Kind.LIST:
            return ast.values.map(parseAnyAst);
        case Kind.BOOLEAN:
        case Kind.ENUM:
        case Kind.FLOAT:
        case Kind.INT:
        case Kind.STRING:
            return ast.value;
        case Kind.NULL:
            return null;
        case Kind.VARIABLE:
            throw new Error("No idea what parsing a 'variable' means");
    }
}
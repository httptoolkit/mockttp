import * as _ from 'lodash';

export class SchemaIntrospector {

    constructor(
        private adminServerSchema: any
    ) {}

    public queryTypeDefined(queryType: string): boolean {
        return this.typeHasField('Query', queryType);
    }

    public typeHasField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.adminServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.fields, { name: fieldName });
    }

    public asOptionalField(typeName: string, fieldName: string): string {
        return (this.typeHasField(typeName, fieldName))
            ? fieldName
            : '';
    }

    public typeHasInputField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.adminServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.inputFields, { name: fieldName });
    }

}

// Taken from src/utilities/introspectionQuery.js in GraphQL-js
// Copied directly, to avoid bundling the whole thing into frontend code.
export const introspectionQuery = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    fields(includeDeprecated: true) {
      name
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      isDeprecated
      deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    type { ...TypeRef }
    defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;
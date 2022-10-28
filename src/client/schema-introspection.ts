import * as _ from 'lodash';

export class SchemaIntrospector {

    constructor(
        private adminServerSchema: any
    ) {}

    public queryTypeDefined(queryType: string): boolean {
        return this.typeHasField('Query', queryType);
    }

    public isTypeDefined(typeName: string): boolean {
        return _.some(this.adminServerSchema.types, { name: typeName });
    }

    public typeHasField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.adminServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.fields, { name: fieldName });
    }

    public asOptionalField(typeName: string | string[], fieldName: string): string {
        const possibleNames = !Array.isArray(typeName) ? [typeName] : typeName;

        const firstAvailableName = possibleNames.find((name) => this.isTypeDefined(name));
        if (!firstAvailableName) return '';

        return (this.typeHasField(firstAvailableName, fieldName))
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